// 見開きレイアウトの計算（DOMに依存しない純粋なロジック）

export type Direction = 'rtl' | 'ltr';
export type SpreadMode = 'auto' | 'single' | 'double';

export interface LayoutOptions {
  numPages: number;
  /** 見開き表示にするか（'auto' は呼び出し側で解決済みの値を渡す） */
  double: boolean;
  /** 1ページ目（表紙）を単独で表示するか */
  coverSingle: boolean;
  /** 横長ページ（見開きが1枚になっているページ）か。未判定は false */
  isWide: (pageIndex: number) => boolean;
}

/** ページ番号（0始まり・ファイル順）の並びを、読む順に並べたスプレッド列にする */
export function buildSpreads(o: LayoutOptions): number[][] {
  const spreads: number[][] = [];
  const n = o.numPages;
  let i = 0;
  if (!o.double) {
    for (; i < n; i++) spreads.push([i]);
    return spreads;
  }
  if (o.coverSingle && n > 0) {
    spreads.push([0]);
    i = 1;
  }
  while (i < n) {
    if (o.isWide(i) || i + 1 >= n || o.isWide(i + 1)) {
      spreads.push([i]);
      i += 1;
    } else {
      spreads.push([i, i + 1]);
      i += 2;
    }
  }
  return spreads;
}

/** あるページを含むスプレッドの番号 */
export function spreadIndexOfPage(spreads: number[][], page: number): number {
  const idx = spreads.findIndex((s) => s.includes(page));
  if (idx >= 0) return idx;
  return Math.max(0, Math.min(spreads.length - 1, page < 0 ? 0 : spreads.length - 1));
}

/** 画面上で左から右に並べるときのページ順。右開きは後ろのページが左に来る */
export function visualOrder(spread: number[], direction: Direction): number[] {
  return direction === 'rtl' ? [...spread].reverse() : [...spread];
}

/** 画面のタップ/スワイプ方向を「次へ/前へ」に変換する */
export function tapSide(side: 'left' | 'right', direction: Direction): 'next' | 'prev' {
  const nextSide = direction === 'rtl' ? 'left' : 'right';
  return side === nextSide ? 'next' : 'prev';
}

/**
 * 水平方向のスワイプ（dx>0 は指が右へ動いた）を「次へ/前へ」に変換する。
 * 右開きの本は左から右へ、左開きの本は右から左へ動かすと、次のページに進む。
 */
export function swipeDir(dx: number, direction: Direction): 'next' | 'prev' {
  const toRight = dx > 0;
  return toRight === (direction === 'rtl') ? 'next' : 'prev';
}

/** 画面の縦横比から、自動モードの見開き/単ページを決める */
export function resolveDouble(mode: SpreadMode, viewportW: number, viewportH: number): boolean {
  if (mode === 'single') return false;
  if (mode === 'double') return true;
  return viewportW / Math.max(1, viewportH) >= 1.15;
}

/** 横長ページかどうか。縦横比が1より大きければ横長とみなす */
export function isWideSize(width: number, height: number): boolean {
  return width > height * 1.05;
}
