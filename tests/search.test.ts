import { describe, expect, it } from 'vitest';
import { foldText, matchesQuery } from '../src/search';

describe('matchesQuery', () => {
  it('Mac で作ったファイル名（濁点が分解された形）でも一致する', () => {
    const nfd = 'ぼくたちの旅.pdf'.normalize('NFD');
    expect(nfd).not.toContain('ぼくたち'); // 素直に比べると見つからない
    expect(matchesQuery(nfd, 'ぼくたち')).toBe(true);
    expect(matchesQuery('ぼくたちの旅.pdf', nfd.slice(0, 6))).toBe(true); // 入力側が分解されていても
  });

  it('ひらがなとカタカナを区別しない', () => {
    expect(matchesQuery('ぼくたちの旅.pdf', 'ボクタチ')).toBe(true);
    expect(matchesQuery('ボクタチの旅.pdf', 'ぼくたち')).toBe(true);
  });

  it('全角・半角、大文字・小文字を区別しない', () => {
    expect(matchesQuery('Travel Guide 2026.pdf', 'travel')).toBe(true);
    expect(matchesQuery('ＴＲＡＶＥＬ ２０２６.pdf', 'travel 2026')).toBe(true);
    expect(matchesQuery('ﾎﾞｸﾀﾁ.pdf', 'ぼくたち')).toBe(true); // 半角カナ
  });

  it('空白で区切った語は、すべて含まれるときだけ一致する（順番は問わない）', () => {
    expect(matchesQuery('地球の歩き方 島旅 小笠原.pdf', '島旅 小笠原')).toBe(true);
    expect(matchesQuery('地球の歩き方 島旅 小笠原.pdf', '小笠原 島旅')).toBe(true);
    expect(matchesQuery('地球の歩き方 島旅 小笠原.pdf', '島旅 沖縄')).toBe(false);
  });

  it('空白や中黒の有無の違いを無視する', () => {
    expect(matchesQuery('地球の歩き方_島旅.pdf', '歩き方島旅')).toBe(true);
    expect(matchesQuery('ぼく・たち.pdf', 'ぼくたち')).toBe(true);
  });

  it('関係のない名前は一致しない。空の検索語は全件に一致', () => {
    expect(matchesQuery('別の雑誌.pdf', 'ぼくたち')).toBe(false);
    expect(matchesQuery('なんでも.pdf', '')).toBe(true);
    expect(matchesQuery('なんでも.pdf', '   ')).toBe(true);
  });

  it('漢字とひらがなは区別される（読みの変換はしない）', () => {
    expect(matchesQuery('僕たちの旅.pdf', 'ぼくたち')).toBe(false);
  });
});

describe('foldText', () => {
  it('同じ見た目の文字は同じ形になる', () => {
    expect(foldText('ぼくたち'.normalize('NFD'))).toBe(foldText('ぼくたち'));
  });
});
