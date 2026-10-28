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

export class DriveClient {
  constructor(private clientId: string) {}

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
    const q = `'${parent}' in parents and trashed=false and (mimeType='application/pdf' or mimeType='${FOLDER_MIME}')`;
    const items: DriveItem[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,mimeType,size,thumbnailLink,modifiedTime)',
        pageSize: '200',
        orderBy: 'folder,name_natural',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await this.fetchJson<{ files: (Omit<DriveItem, 'size'> & { size?: string })[]; nextPageToken?: string }>(
        `${API}/files?${params}`,
      );
      for (const f of r.files) items.push({ ...f, size: f.size ? Number(f.size) : undefined });
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
  async fetchRange(fileId: string, begin: number, endExclusive: number): Promise<Uint8Array | null> {
    const res = await this.fetchAuthed(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, {
      headers: { Range: `bytes=${begin}-${endExclusive - 1}` },
    });
    if (res.status !== 206) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  async fetchAll(fileId: string): Promise<Uint8Array> {
    const res = await this.fetchAuthed(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`);
    return new Uint8Array(await res.arrayBuffer());
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
