// 取得したブロックを IndexedDB に保存して、次に開くときの再ダウンロードを避ける。
// ブラウザ標準の HTTP キャッシュは、認証つきの Range 取得（Drive API）にはほぼ効かないため、自前で持つ。
// 保存はあくまで「あれば使う」もの。失敗しても読書は止めない（呼び出し側で握りつぶす）。

const DB_NAME = 'dpr-cache';
const BLOCKS = 'blocks';
const FILES = 'files';

export interface FileMeta {
  /** ファイルID + 版（modifiedTime）。版が変わると別物として扱う */
  key: string;
  fileId: string;
  name: string;
  /** 保存している合計バイト数 */
  bytes: number;
  /** 保存しているブロックの数 */
  blocks: number;
  lastUsed: number;
}

const blockKey = (fileKey: string, idx: number) => `${fileKey}#${idx}`;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export class BlockStore {
  private constructor(private db: IDBDatabase) {}

  /** 使えない環境（プライベートブラウズなど）では null */
  static async open(): Promise<BlockStore | null> {
    try {
      if (typeof indexedDB === 'undefined') return null;
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(BLOCKS);
        r.result.createObjectStore(FILES, { keyPath: 'key' });
      };
      return new BlockStore(await req(r));
    } catch {
      return null;
    }
  }

  /** 保存済みのブロックを返す。長さが違うもの（壊れている・版違い）は無かったことにする */
  async get(fileKey: string, idx: number, expectedLength: number): Promise<Uint8Array | null> {
    try {
      const buf = await req(this.db.transaction(BLOCKS).objectStore(BLOCKS).get(blockKey(fileKey, idx)) as IDBRequest<ArrayBuffer | undefined>);
      if (!buf || buf.byteLength !== expectedLength) return null;
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async put(fileKey: string, idx: number, data: Uint8Array, info: { fileId: string; name: string }): Promise<void> {
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const tx = this.db.transaction([BLOCKS, FILES], 'readwrite');
    const blocks = tx.objectStore(BLOCKS);
    const files = tx.objectStore(FILES);
    const key = blockKey(fileKey, idx);
    const existing = await req(blocks.get(key) as IDBRequest<ArrayBuffer | undefined>);
    const meta = (await req(files.get(fileKey) as IDBRequest<FileMeta | undefined>)) ?? {
      key: fileKey, fileId: info.fileId, name: info.name, bytes: 0, blocks: 0, lastUsed: 0,
    };
    meta.bytes += copy.byteLength - (existing?.byteLength ?? 0);
    if (!existing) meta.blocks++;
    meta.lastUsed = Date.now();
    blocks.put(copy, key);
    files.put(meta);
    await done(tx);
  }

  /** そのファイルの保存済みバイト数（なければ 0） */
  async cachedBytes(fileKey: string): Promise<number> {
    try {
      const m = await req(this.db.transaction(FILES).objectStore(FILES).get(fileKey) as IDBRequest<FileMeta | undefined>);
      return m?.bytes ?? 0;
    } catch {
      return 0;
    }
  }

  /** 使ったことを記録する（LRU の順序に使う） */
  async touch(fileKey: string): Promise<void> {
    try {
      const tx = this.db.transaction(FILES, 'readwrite');
      const files = tx.objectStore(FILES);
      const m = await req(files.get(fileKey) as IDBRequest<FileMeta | undefined>);
      if (m) { m.lastUsed = Date.now(); files.put(m); }
      await done(tx);
    } catch { /* 記録できなくても読書には影響しない */ }
  }

  async list(): Promise<FileMeta[]> {
    try {
      return await req(this.db.transaction(FILES).objectStore(FILES).getAll() as IDBRequest<FileMeta[]>);
    } catch {
      return [];
    }
  }

  async totalBytes(): Promise<number> {
    return (await this.list()).reduce((a, m) => a + m.bytes, 0);
  }

  /** ブロックのキー範囲（`<fileKey>#0` 以上、`<fileKey>$` 未満。'#' の次の文字が '$'） */
  private range(fileKey: string): IDBKeyRange {
    return IDBKeyRange.bound(`${fileKey}#`, `${fileKey}$`, false, true);
  }

  async removeFile(fileKey: string): Promise<void> {
    const tx = this.db.transaction([BLOCKS, FILES], 'readwrite');
    tx.objectStore(BLOCKS).delete(this.range(fileKey));
    tx.objectStore(FILES).delete(fileKey);
    await done(tx);
  }

  /** 同じファイルの古い版を消す（ファイルが更新されたとき） */
  async removeOtherVersions(fileId: string, keepKey: string): Promise<void> {
    for (const m of await this.list()) if (m.fileId === fileId && m.key !== keepKey) await this.removeFile(m.key);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([BLOCKS, FILES], 'readwrite');
    tx.objectStore(BLOCKS).clear();
    tx.objectStore(FILES).clear();
    await done(tx);
  }

  /** 合計が上限を超えていたら、最後に使った日時が古いファイルから、ファイル単位で消す。消したファイル数を返す */
  async trim(limitBytes: number, keepKey?: string): Promise<number> {
    let removed = 0;
    const metas = (await this.list()).sort((a, b) => a.lastUsed - b.lastUsed);
    let total = metas.reduce((a, m) => a + m.bytes, 0);
    for (const m of metas) {
      if (total <= limitBytes) break;
      if (m.key === keepKey) continue; // いま使っているファイルは消さない
      await this.removeFile(m.key);
      total -= m.bytes;
      removed++;
    }
    return removed;
  }
}

/** ファイルの版を含む保存用のキー。更新されたファイルは別のキーになるので、古いデータは使われない */
export function fileCacheKey(fileId: string, version: string | number | undefined): string {
  return `${fileId}@${version ?? 'x'}`;
}
