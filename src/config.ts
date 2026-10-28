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

/**
 * Drive の共有リンク・プレビューURL・ファイルIDからファイルIDを取り出す。
 * 例: https://drive.google.com/file/d/<ID>/view, https://drive.google.com/open?id=<ID>
 * フォルダのURLや、IDらしくない文字列は null。
 */
export function parseFileId(input: string): string | null {
  const s = input.trim();
  if (!s || /\/folders\//.test(s)) return null;
  const m = s.match(/\/file\/d\/([\w-]+)/) ?? s.match(/[?&]id=([\w-]+)/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : null;
}

/** アプリのURLの ?fileId=... から開く本のIDを取り出す */
export function fileIdFromLocation(search: string): string | null {
  const id = new URLSearchParams(search).get('fileId');
  return id && /^[\w-]+$/.test(id) ? id : null;
}

/** Drive の画面で押すと、開いているPDFをこのアプリで開くブックマークレット */
export function bookmarklet(appUrl: string): string {
  const code = `(()=>{const l=location.href,m=l.match(/\\/file\\/d\\/([\\w-]+)/)||l.match(/[?&]id=([\\w-]+)/);` +
    `m?window.open(${JSON.stringify(appUrl)}+'?fileId='+m[1],'_blank'):alert('Google Drive でPDFを開いた状態で押してください')})()`;
  return `javascript:${encodeURIComponent(code)}`;
}
