// Google Identity Services のトークンフローでアクセストークンを取得する（クライアントシークレット不要）

const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  // 読書位置の同期用。アプリ専用の隠しフォルダにだけ書き込める
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string }): void }
interface GoogleGlobal {
  accounts: { oauth2: { initTokenClient(c: {
    client_id: string; scope: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type: string }) => void;
  }): TokenClient } };
}

let token: { value: string; expiresAt: number } | null = null;
let client: TokenClient | null = null;
let pending: { resolve: (t: string) => void; reject: (e: Error) => void }[] = [];

const TOKEN_KEY = 'dpr:token';
const HINT_KEY = 'dpr:signedin';

function loadScript(): Promise<void> {
  if ((window as unknown as { google?: GoogleGlobal }).google?.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google ログイン用スクリプトを読み込めませんでした（オフラインの可能性があります）'));
    document.head.appendChild(s);
  });
}

function restoreToken(): void {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (raw) token = JSON.parse(raw);
  } catch { /* ignore */ }
}

export function hasSignedInBefore(): boolean {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}

async function ensureClient(clientId: string): Promise<TokenClient> {
  if (client) return client;
  await loadScript();
  const g = (window as unknown as { google: GoogleGlobal }).google;
  client = g.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (r) => {
      const list = pending; pending = [];
      if (r.error || !r.access_token) {
        list.forEach((p) => p.reject(new Error(`ログインに失敗しました: ${r.error ?? '不明なエラー'}`)));
        return;
      }
      token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
      try {
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
        localStorage.setItem(HINT_KEY, '1');
      } catch { /* ignore */ }
      list.forEach((p) => p.resolve(token!.value));
    },
    error_callback: (e) => {
      const list = pending; pending = [];
      list.forEach((p) => p.reject(new Error(`ログインを完了できませんでした（${e.type}）`)));
    },
  });
  return client;
}

/**
 * 有効なアクセストークンを返す。期限が近ければ取り直す。
 * interactive=false のときは同意画面を出さずに取得を試みる（初回は失敗しうる）。
 */
export async function getToken(clientId: string, interactive: boolean): Promise<string> {
  if (!token) restoreToken();
  if (token && token.expiresAt - Date.now() > 60_000) return token.value;
  const c = await ensureClient(clientId);
  return new Promise<string>((resolve, reject) => {
    pending.push({ resolve, reject });
    if (pending.length === 1) c.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

export function signOut(): void {
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(HINT_KEY);
  } catch { /* ignore */ }
}
