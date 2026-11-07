import { describe, expect, it } from 'vitest';
import { agoText, defaultBookState, mergeStates, recentBooks } from '../src/store/progress';

const st = (page: number, updatedAt: number) => ({ ...defaultBookState(), page, updatedAt });

describe('mergeStates', () => {
  it('本ごとに新しい方を採用する', () => {
    const local = { a: st(10, 200), b: st(1, 100) };
    const remote = { a: st(5, 100), b: st(7, 300), c: st(3, 50) };
    const m = mergeStates(local, remote);
    expect(m.a.page).toBe(10);
    expect(m.b.page).toBe(7);
    expect(m.c.page).toBe(3);
  });
  it('入力を壊さない', () => {
    const local = { a: st(1, 1) };
    mergeStates(local, { a: st(2, 2) });
    expect(local.a.page).toBe(1);
  });
});

describe('recentBooks', () => {
  const book = (title: string, lastOpenedAt: number) => ({ ...defaultBookState(), title, lastOpenedAt });
  it('新しく開いた順に並べ、件数を絞る', () => {
    const r = recentBooks({ a: book('A', 100), b: book('B', 300), c: book('C', 200) }, 2);
    expect(r.map((x) => x.id)).toEqual(['b', 'c']);
  });
  it('端末内のファイル・履歴から外した本・タイトルのない記録は含まない', () => {
    const r = recentBooks({
      'local:x': book('L', 999),
      gone: book('G', 0),
      old: { ...defaultBookState(), page: 3, updatedAt: 5 }, // 以前の版の記録（タイトルなし）
      ok: book('OK', 10),
    });
    expect(r.map((x) => x.id)).toEqual(['ok']);
  });
});

describe('agoText', () => {
  const now = new Date('2026-11-07T12:00:00').getTime();
  it('経過時間を読みやすく表す', () => {
    expect(agoText(now - 10_000, now)).toBe('たった今');
    expect(agoText(now - 5 * 60_000, now)).toBe('5 分前');
    expect(agoText(now - 3 * 3600_000, now)).toBe('3 時間前');
    expect(agoText(now - 2 * 86400_000, now)).toBe('2 日前');
    expect(agoText(now - 60 * 86400_000, now)).toBe('2026/9/8');
  });
});
