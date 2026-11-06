// 大きなファイルを開く前の確認の設定と、これまで開くのにかかった時間の記録

const KEY_CONFIRM = 'dpr:confirmMB';
const KEY_HISTORY = 'dpr:openHistory';

/** 確認を出すファイルサイズ（MB）の既定値 */
export const DEFAULT_CONFIRM_MB = 50;
/** 確認するしきい値の選択肢（0 は確認しない） */
export const CONFIRM_CHOICES = [0, 30, 50, 100, 200];

export interface OpenRecord {
  /** ファイルサイズ（バイト） */
  size: number;
  /** 最初のページが出るまでの時間（ミリ秒） */
  ms: number;
  /** その間に取得した量（バイト） */
  bytes: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できない環境では何もしない */ }
}

export function getConfirmMB(): number {
  const v = read<number>(KEY_CONFIRM, DEFAULT_CONFIRM_MB);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CONFIRM_MB;
}

export function setConfirmMB(mb: number): void {
  write(KEY_CONFIRM, mb);
}

/** 確認が必要か（サイズが不明なら確認しない） */
export function needsConfirm(sizeBytes: number | undefined, thresholdMB: number): boolean {
  return thresholdMB > 0 && !!sizeBytes && sizeBytes >= thresholdMB * 1e6;
}

export function loadHistory(): OpenRecord[] {
  const h = read<OpenRecord[]>(KEY_HISTORY, []);
  return Array.isArray(h) ? h.filter((r) => r && r.ms > 0 && r.size > 0) : [];
}

export function addHistory(r: OpenRecord): void {
  write(KEY_HISTORY, [...loadHistory(), r].slice(-12));
}

/** 最初のページまでに取得する量の目安（バイト）。実測では、数十 MB を先読みして開く */
export function expectedFirstPageBytes(size: number): number {
  return Math.min(size, 40e6);
}

/**
 * 過去の記録から、開くまでの時間の目安（秒）を出す。
 * 大きいファイル（30MB 以上）の記録の中央値。記録がなければ null
 */
export function estimateOpenSeconds(history: OpenRecord[]): number | null {
  const big = history.filter((r) => r.size >= 30e6).map((r) => r.ms).sort((a, b) => a - b);
  if (big.length === 0) return null;
  return Math.round(big[Math.floor(big.length / 2)] / 1000);
}
