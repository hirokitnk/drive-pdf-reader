import { describe, expect, it } from 'vitest';
import { defaultBookState, mergeStates } from '../src/store/progress';

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
