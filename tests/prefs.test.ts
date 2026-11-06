import { describe, expect, it } from 'vitest';
import { confirmLines } from '../src/confirm';
import { estimateOpenSeconds, expectedFirstPageBytes, needsConfirm } from '../src/prefs';

describe('needsConfirm', () => {
  it('しきい値以上のときだけ確認する', () => {
    expect(needsConfirm(120e6, 50)).toBe(true);
    expect(needsConfirm(50e6, 50)).toBe(true);
    expect(needsConfirm(49e6, 50)).toBe(false);
  });
  it('0 は確認しない。サイズ不明も確認しない', () => {
    expect(needsConfirm(999e6, 0)).toBe(false);
    expect(needsConfirm(undefined, 50)).toBe(false);
  });
});

describe('expectedFirstPageBytes', () => {
  it('小さいファイルはそのサイズ、大きいファイルは上限で頭打ち', () => {
    expect(expectedFirstPageBytes(10e6)).toBe(10e6);
    expect(expectedFirstPageBytes(300e6)).toBe(40e6);
  });
});

describe('estimateOpenSeconds', () => {
  it('記録がなければ null', () => {
    expect(estimateOpenSeconds([])).toBeNull();
    expect(estimateOpenSeconds([{ size: 5e6, ms: 1000, bytes: 1 }])).toBeNull(); // 小さいファイルは対象外
  });
  it('大きいファイルの記録の中央値（秒）を返す', () => {
    const h = [10e3, 30e3, 20e3].map((ms) => ({ size: 100e6, ms, bytes: 1 }));
    expect(estimateOpenSeconds(h)).toBe(20);
  });
});

describe('confirmLines', () => {
  it('サイズ・通信量の目安・時間の目安を含む', () => {
    const l = confirmLines('本', 101e6, null);
    expect(l[0]).toContain('101 MB');
    expect(l[1]).toContain('40 MB');
    expect(l[2]).toContain('目安がありません');
    expect(confirmLines('本', 101e6, 25)[2]).toContain('25 秒');
  });
});
