// 設定: ビルド時の環境変数を既定値にして、画面から上書きできる（localStorage）

export interface Config {
  clientId: string;
  /** 本棚の起点のフォルダID。空なら「マイドライブ」直下 */
  folderId: string;
}

const KEY = 'dpr:config';

export function loadConfig(): Config {
  const base: Config = {
    clientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '',
    folderId: (import.meta.env.VITE_DRIVE_FOLDER_ID as string | undefined) ?? '',
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<Config>) };
  } catch { /* ignore */ }
  return base;
}

export function saveConfig(c: Config): void {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

/** Driveのフォルダ URL またはIDからフォルダIDを取り出す */
export function parseFolderId(input: string): string {
  const s = input.trim();
  if (!s) return '';
  const m = s.match(/\/folders\/([\w-]+)/) ?? s.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : s;
}
