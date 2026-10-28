import { describe, expect, it } from 'vitest';
import {
  buildSpreads, isWideSize, resolveDouble, spreadIndexOfPage, swipeDir, tapSide, visualOrder,
} from '../src/viewer/layout';

const none = () => false;

describe('buildSpreads', () => {
  it('単ページ表示では1ページずつ', () => {
    expect(buildSpreads({ numPages: 3, double: false, coverSingle: true, isWide: none }))
      .toEqual([[0], [1], [2]]);
  });
  it('表紙単独の見開き: [0] [1,2] [3,4] ... 末尾は余り', () => {
    expect(buildSpreads({ numPages: 6, double: true, coverSingle: true, isWide: none }))
      .toEqual([[0], [1, 2], [3, 4], [5]]);
  });
  it('表紙単独でない見開き', () => {
    expect(buildSpreads({ numPages: 5, double: true, coverSingle: false, isWide: none }))
      .toEqual([[0, 1], [2, 3], [4]]);
  });
  it('横長ページは単独で、その前後で組み直される', () => {
    const wide = (p: number) => p === 3;
    expect(buildSpreads({ numPages: 7, double: true, coverSingle: true, isWide: wide }))
      .toEqual([[0], [1, 2], [3], [4, 5], [6]]);
  });
  it('横長ページの直前の1ページは単独になる', () => {
    const wide = (p: number) => p === 2;
    expect(buildSpreads({ numPages: 5, double: true, coverSingle: true, isWide: wide }))
      .toEqual([[0], [1], [2], [3, 4]]);
  });
  it('0ページでも落ちない', () => {
    expect(buildSpreads({ numPages: 0, double: true, coverSingle: true, isWide: none })).toEqual([]);
  });
});

describe('spreadIndexOfPage', () => {
  const sp = [[0], [1, 2], [3, 4]];
  it('ページを含むスプレッドを返す', () => {
    expect(spreadIndexOfPage(sp, 0)).toBe(0);
    expect(spreadIndexOfPage(sp, 2)).toBe(1);
    expect(spreadIndexOfPage(sp, 4)).toBe(2);
  });
  it('範囲外は端に丸める', () => {
    expect(spreadIndexOfPage(sp, 99)).toBe(2);
    expect(spreadIndexOfPage(sp, -1)).toBe(0);
  });
});

describe('方向', () => {
  it('右開きは後ろのページが左に並ぶ', () => {
    expect(visualOrder([1, 2], 'rtl')).toEqual([2, 1]);
    expect(visualOrder([1, 2], 'ltr')).toEqual([1, 2]);
  });
  it('タップ: 右開きは左が「次」', () => {
    expect(tapSide('left', 'rtl')).toBe('next');
    expect(tapSide('right', 'rtl')).toBe('prev');
    expect(tapSide('right', 'ltr')).toBe('next');
    expect(tapSide('left', 'ltr')).toBe('prev');
  });
  it('スワイプ: 右開きは右へ動かすと「次」', () => {
    expect(swipeDir(100, 'rtl')).toBe('next');
    expect(swipeDir(-100, 'rtl')).toBe('prev');
    expect(swipeDir(-100, 'ltr')).toBe('next');
    expect(swipeDir(100, 'ltr')).toBe('prev');
  });
});

describe('resolveDouble / isWideSize', () => {
  it('自動は横長の画面で見開き', () => {
    expect(resolveDouble('auto', 1200, 800)).toBe(true);
    expect(resolveDouble('auto', 800, 1200)).toBe(false);
    expect(resolveDouble('single', 1200, 800)).toBe(false);
    expect(resolveDouble('double', 800, 1200)).toBe(true);
  });
  it('横長ページの判定', () => {
    expect(isWideSize(1200, 800)).toBe(true);
    expect(isWideSize(800, 1200)).toBe(false);
    expect(isWideSize(100, 100)).toBe(false);
  });
});
