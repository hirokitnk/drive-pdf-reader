// 検索のための文字のそろえ方。ファイル名と入力を同じ形にしてから比べる。

/**
 * 見た目が同じでも、文字列としては別になる違いをなくす。
 * - NFKC: Mac で作ったファイル名の「か＋゛」などの分解された濁点を 1 文字にまとめ、全角英数・半角カナも通常の形にする
 * - 小文字にそろえる
 * - カタカナをひらがなにそろえる（「ボクタチ」で「ぼくたち」を探せるように）
 * - 空白・中黒・長音の前後の揺れなど、区切りの違いを無視する
 */
export function foldText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･_\-‐–—]+/g, '');
}

/** 検索語を空白で分けた各語が、すべて名前に含まれるか（AND 検索）。語が空なら全件に一致 */
export function matchesQuery(name: string, query: string): boolean {
  const words = query.normalize('NFKC').split(/[\s　]+/).map(foldText).filter(Boolean);
  if (words.length === 0) return true;
  const folded = foldText(name);
  return words.every((w) => folded.includes(w));
}
