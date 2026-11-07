import type { Direction, SpreadMode } from '../viewer/layout';

/** 本ごとの読書位置と表示設定 */
export interface BookState {
  /** 現在のページ（0始まり・スプレッドの先頭ページ） */
  page: number;
  numPages?: number;
  /** 未設定ならPDFのメタデータ→既定値で決める */
  direction?: Direction;
  spreadMode: SpreadMode;
  coverSingle: boolean;
  updatedAt: number;
  /** 「最近開いた本」の一覧に出すための情報（Drive の本のみ）。lastOpenedAt が 0 なら履歴から消した状態 */
  title?: string;
  size?: number;
  mtime?: string;
  lastOpenedAt?: number;
}

export type BookStates = Record<string, BookState>;

export const defaultBookState = (): BookState => ({
  page: 0,
  spreadMode: 'auto',
  coverSingle: true,
  updatedAt: 0,
});

/** 本ごとに updatedAt が新しい方を採用してマージする（端末間同期用） */
export function mergeStates(a: BookStates, b: BookStates): BookStates {
  const out: BookStates = { ...a };
  for (const [id, s] of Object.entries(b)) {
    const cur = out[id];
    if (!cur || s.updatedAt > cur.updatedAt) out[id] = s;
  }
  return out;
}

const KEY = 'dpr:states';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadLocalStates(): BookStates {
  try {
    const raw = storage()?.getItem(KEY);
    return raw ? (JSON.parse(raw) as BookStates) : {};
  } catch {
    return {};
  }
}

export function saveLocalStates(states: BookStates): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(states));
  } catch {
    /* 保存できない環境では何もしない */
  }
}

export interface RecentBook { id: string; state: BookState }

/** 最近開いた Drive の本を、新しい順に返す（端末内のファイル・履歴から消した本は含まない） */
export function recentBooks(states: BookStates, limit = 8): RecentBook[] {
  return Object.entries(states)
    .filter(([id, s]) => !id.startsWith('local:') && !!s.title && (s.lastOpenedAt ?? 0) > 0)
    .sort((a, b) => (b[1].lastOpenedAt ?? 0) - (a[1].lastOpenedAt ?? 0))
    .slice(0, limit)
    .map(([id, state]) => ({ id, state }));
}

/** 「3 時間前」のような、読みやすい経過時間 */
export function agoText(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min} 分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 時間前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 日前`;
  const dt = new Date(ts);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}
