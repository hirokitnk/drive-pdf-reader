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
