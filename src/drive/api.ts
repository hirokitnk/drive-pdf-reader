import { getToken } from './auth';
import { mergeStates, type BookStates } from '../store/progress';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  thumbnailLink?: string;
  modifiedTime?: string;
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const isFolder = (i: DriveItem) => i.mimeType === FOLDER_MIME;

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/**
 * PDF として扱うファイル。
 * - application/pdf
 * - PDF へのショートカット（実体は shortcutDetails.targetId）
 * - 種類が不明（octet-stream）になっているが、名前が .pdf のもの（他のツールでアップロードされたもの）
 */
const PDF_QUERY =
  `mimeType='application/pdf' or mimeType='${SHORTCUT_MIME}' or (mimeType='application/octet-stream' and name contains '.pdf')`;
const PDF_OR_FOLDER_QUERY = `${PDF_QUERY} or mimeType='${FOLDER_MIME}'`;

interface RawItem {
  id: string; name: string; mimeType: string; size?: string; thumbnailLink?: string; modifiedTime?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

/** API の応答を DriveItem にする。PDF でも フォルダでもないものは null */
export function toItem(f: RawItem): DriveItem | null {
  const base = { name: f.name, thumbnailLink: f.thumbnailLink, modifiedTime: f.modifiedTime };
  const size = f.size ? Number(f.size) : undefined;
  if (f.mimeType === SHORTCUT_MIME) {
    const t = f.shortcutDetails;
    // ショートカットは、指す先を開く（PDF とフォルダ以外へのショートカットは無視）
    if (t?.targetId && t.targetMimeType === 'application/pdf') return { ...base, id: t.targetId, mimeType: 'application/pdf' };
    if (t?.targetId && t.targetMimeType === FOLDER_MIME) return { ...base, id: t.targetId, mimeType: FOLDER_MIME };
    return null;
  }
  if (f.mimeType === 'application/octet-stream') {
    return /\.pdf$/i.test(f.name) ? { ...base, id: f.id, mimeType: 'application/pdf', size } : null;
  }
  if (f.mimeType === 'application/pdf' || f.mimeType === FOLDER_MIME) return { ...base, id: f.id, mimeType: f.mimeType, size };
  return null;
}

export class DriveClient {
  constructor(private clientId: string) {}

  /** 診断用: 現在のアクセストークン */
  accessToken(): Promise<string> {
    return getToken(this.clientId, false);
  }

  private async fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchAuthed(url, init);
    return (await res.json()) as T;
  }

  /** 認証ヘッダ付きの fetch。401 のときは1度だけトークンを取り直す */
  async fetchAuthed(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(this.clientId, false);
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      const res = await fetch(url, { ...init, headers });
      if (res.status === 401 && attempt === 0) {
        // 期限切れ扱いにして取り直す
        try { sessionStorage.removeItem('dpr:token'); } catch { /* ignore */ }
        continue;
      }
      if (!res.ok && res.status !== 206) {
        throw new Error(`Drive API エラー (${res.status}): ${(await res.text()).slice(0, 200)}`);
      }
      return res;
    }
    throw new Error('Drive API の認証に失敗しました');
  }

  /** フォルダ直下のサブフォルダとPDFを一覧する（フォルダ→名前順） */
  async list(folderId: string): Promise<DriveItem[]> {
    const parent = folderId || 'root';
    const q = `'${parent}' in parents and trashed=false and (${PDF_OR_FOLDER_QUERY})`;
    return this.listPaged(q, { corpora: undefined });
  }

  /**
   * Drive 全体（サブフォルダ、共有アイテム、共有ドライブを含む）の PDF を集めて返す。検索用。
   * onProgress には、これまでに集めた件数を渡す。
   */
  async listAllPdfs(onProgress?: (count: number) => void): Promise<DriveItem[]> {
    const q = `trashed=false and (${PDF_QUERY})`;
    return this.listPaged(q, { corpora: 'allDrives', onProgress, onlyPdf: true });
  }

  private async listPaged(
    q: string,
    o: { corpora?: string; onProgress?: (count: number) => void; onlyPdf?: boolean },
  ): Promise<DriveItem[]> {
    const items: DriveItem[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,mimeType,size,thumbnailLink,modifiedTime,shortcutDetails(targetId,targetMimeType))',
        pageSize: '1000',
        orderBy: 'folder,name_natural',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (o.corpora) params.set('corpora', o.corpora);
      if (pageToken) params.set('pageToken', pageToken);
      const r = await this.fetchJson<{ files: RawItem[]; nextPageToken?: string }>(`${API}/files?${params}`);
      for (const f of r.files) {
        const item = toItem(f);
        if (item && (!o.onlyPdf || !isFolder(item))) items.push(item);
      }
      o.onProgress?.(items.length);
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
    return items;
  }

  async getMeta(fileId: string): Promise<DriveItem> {
    const r = await this.fetchJson<Omit<DriveItem, 'size'> & { size?: string }>(
      `${API}/files/${fileId}?fields=id,name,mimeType,size,thumbnailLink,modifiedTime&supportsAllDrives=true`,
    );
    return { ...r, size: r.size ? Number(r.size) : undefined };
  }

  /** 指定範囲のバイト列を取得する。サーバーが Range を無視したら null を返す */
  async fetchRange(fileId: string, begin: number, endExclusive: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const res = await this.fetchAuthed(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, {
      headers: { Range: `bytes=${begin}-${endExclusive - 1}` },
      signal,
    });
    if (res.status !== 206) {
      void res.body?.cancel(); // 全体が返ってきたら、読まずに捨てる
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** ファイル全体を取得する。onProgress で取得済みバイト数を通知する */
  async fetchAll(fileId: string, o: { signal?: AbortSignal; onProgress?: (loaded: number) => void } = {}): Promise<Uint8Array> {
    const res = await this.fetchAuthed(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, { signal: o.signal });
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      o.onProgress?.(loaded);
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const part of parts) { out.set(part, off); off += part.length; }
    return out;
  }

  // ---- 読書位置の同期（appDataFolder） ----
  private async findStateFileId(): Promise<string | null> {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: "name='states.json'",
      fields: 'files(id)',
    });
    const r = await this.fetchJson<{ files: { id: string }[] }>(`${API}/files?${params}`);
    return r.files[0]?.id ?? null;
  }

  async loadRemoteStates(): Promise<BookStates> {
    const id = await this.findStateFileId();
    if (!id) return {};
    const res = await this.fetchAuthed(`${API}/files/${id}?alt=media`);
    try {
      return (await res.json()) as BookStates;
    } catch {
      return {};
    }
  }

  /** リモートの内容とマージしてから書き込む。マージ結果を返す */
  async pushStates(local: BookStates): Promise<BookStates> {
    const id = await this.findStateFileId();
    let merged = local;
    if (id) {
      const res = await this.fetchAuthed(`${API}/files/${id}?alt=media`);
      try { merged = mergeStates(await res.json() as BookStates, local); } catch { /* 壊れていたら上書き */ }
    }
    const body = JSON.stringify(merged);
    if (id) {
      await this.fetchAuthed(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } else {
      const boundary = 'dprboundary';
      const meta = JSON.stringify({ name: 'states.json', parents: ['appDataFolder'], mimeType: 'application/json' });
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      await this.fetchAuthed(`${UPLOAD}/files?uploadType=multipart`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart,
      });
    }
    return merged;
  }
}
