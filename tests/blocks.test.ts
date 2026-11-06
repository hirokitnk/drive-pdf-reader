import { describe, expect, it } from 'vitest';
import { BlockLoader, type BlockLoaderOptions } from '../src/viewer/blocks';

const BS = 100;
const SIZE = 1000;

/** 位置ごとに値が決まるデータ（切り出しの位置ずれを検出できる） */
const bytesAt = (begin: number, end: number) => Uint8Array.from({ length: end - begin }, (_, i) => (begin + i) % 251);

/** fetchBlock を手動で完了させられる偽物 */
function harness(over: Partial<BlockLoaderOptions> = {}) {
  const calls: number[] = [];
  const pending = new Map<number, { resolve: (d: Uint8Array) => void; reject: (e: Error) => void }>();
  const delivered: { begin: number; data: Uint8Array }[] = [];
  const errors: Error[] = [];
  const loader = new BlockLoader({
    size: SIZE, blockSize: BS, concurrency: 3, readAhead: 4, maxCachedBlocks: 100, retries: 0, retryDelayMs: 0,
    fetchBlock: (begin, end) => new Promise((resolve, reject) => {
      calls.push(begin / BS);
      pending.set(begin / BS, { resolve: () => resolve(bytesAt(begin, end)), reject });
    }),
    deliver: (begin, data) => delivered.push({ begin, data }),
    onError: (e) => errors.push(e),
    ...over,
  });
  const finish = async (b: number) => { pending.get(b)!.resolve(new Uint8Array()); pending.delete(b); await Promise.resolve(); await Promise.resolve(); };
  return { loader, calls, pending, delivered, errors, finish };
}

describe('BlockLoader: 取得の順序', () => {
  it('要求されたブロックを最優先で取り、同時数を超えない', () => {
    const h = harness();
    h.loader.hold(0);
    h.loader.demand(500, 520);
    expect(h.calls[0]).toBe(5);
    expect(h.calls.length).toBeLessThanOrEqual(3);
  });

  it('要求されたあと、空いた枠で末尾・先頭の続きを先読みする（初期データのブロックは取らない）', () => {
    const h = harness();
    h.loader.hold(0);
    h.loader.demand(500, 510);
    expect(h.calls).toEqual([5, 9, 1]);
    expect(h.calls).not.toContain(0);
  });

  it('同じブロックを二重に取らない', () => {
    const h = harness();
    h.loader.demand(300, 350);
    h.loader.demand(310, 360);
    expect(h.calls.filter((c) => c === 3)).toHaveLength(1);
  });

  it('要求が複数ブロックにまたがるとき、すべてを取る', () => {
    const h = harness({ concurrency: 10 });
    h.loader.demand(250, 560);
    expect([2, 3, 4, 5].every((b) => h.calls.includes(b))).toBe(true);
  });

  it('最後の小さいブロックでも終端を越えない', () => {
    const h = harness({ size: 950, concurrency: 10 });
    h.loader.demand(900, 950);
    expect(h.calls).toContain(9);
  });
});

describe('BlockLoader: PDF.js への返答', () => {
  it('要求された範囲ぴったりを、中身も正しく返す（1 ブロック内）', async () => {
    const h = harness();
    h.loader.demand(320, 380);
    await h.finish(3);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].begin).toBe(320);
    expect(Array.from(h.delivered[0].data)).toEqual(Array.from(bytesAt(320, 380)));
  });

  it('複数ブロックにまたがる要求は、揃ってから 1 回で返す', async () => {
    const h = harness({ concurrency: 10 });
    h.loader.demand(250, 560);
    await h.finish(2);
    await h.finish(3);
    expect(h.delivered).toHaveLength(0); // まだ揃っていない
    await h.finish(4);
    await h.finish(5);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].begin).toBe(250);
    expect(Array.from(h.delivered[0].data)).toEqual(Array.from(bytesAt(250, 560)));
  });

  it('先読み済みのブロックは、再取得せずにキャッシュから返す', async () => {
    const h = harness({ concurrency: 10 });
    h.loader.hold(0);
    h.loader.demand(500, 510); // 先読み: 9, 1, 2, 6, 7 ...
    await h.finish(1);
    const before = h.calls.length;
    h.loader.demand(120, 180);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].begin).toBe(120);
    expect(Array.from(h.delivered[0].data)).toEqual(Array.from(bytesAt(120, 180)));
    expect(h.calls.filter((c) => c === 1)).toHaveLength(1);
    expect(h.calls.length).toBeGreaterThanOrEqual(before); // 追加の取得は先読みのみ
  });

  it('開くときに取った末尾ブロック（provide）も、要求されたらそこから返す', () => {
    const h = harness();
    h.loader.provide(9, bytesAt(900, 1000));
    h.loader.demand(950, 1000);
    expect(h.delivered).toHaveLength(1);
    expect(Array.from(h.delivered[0].data)).toEqual(Array.from(bytesAt(950, 1000)));
    expect(h.calls).not.toContain(9);
  });

  it('同じ位置への要求が重なっても、要求の数だけ返す', async () => {
    const h = harness();
    h.loader.demand(300, 350);
    h.loader.demand(300, 350);
    await h.finish(3);
    expect(h.delivered.map((d) => d.begin)).toEqual([300, 300]);
  });
});

describe('BlockLoader: キャッシュの上限', () => {
  it('上限を超えたら渡し済みのブロックから捨て、要求されたら取り直す', async () => {
    const h = harness({ maxCachedBlocks: 2, concurrency: 10, readAhead: 0 });
    for (const b of [3, 4, 5]) { h.loader.demand(b * BS, b * BS + 10); await h.finish(b); }
    expect(h.loader.stats().cached).toBeLessThanOrEqual(2);
    h.loader.demand(300, 310); // 捨てられたブロック 3 を、もう一度要求
    expect(h.calls.filter((c) => c === 3).length).toBe(2);
  });
});

describe('BlockLoader: 失敗と停止', () => {
  it('要求されたブロックの取得に失敗したら、再試行したうえでエラーにする', async () => {
    const h = harness({ retries: 1, concurrency: 1 });
    h.loader.hold(0);
    h.loader.demand(300, 350);
    h.pending.get(3)!.reject(new Error('boom'));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.calls.filter((c) => c === 3)).toHaveLength(2);
    h.pending.get(3)!.reject(new Error('boom2'));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.errors).toHaveLength(1);
  });

  it('先読みの失敗はエラーにしない', async () => {
    const h = harness({ concurrency: 1 });
    h.loader.hold(0);
    h.loader.demand(500, 510);
    await h.finish(5); // 要求されたブロックが終わると、次は先読み（末尾の 9）
    h.pending.get(9)!.reject(new Error('先読み失敗'));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.errors).toHaveLength(0);
  });

  it('stop したあとは何もしない', () => {
    const h = harness();
    h.loader.stop();
    h.loader.demand(300, 350);
    expect(h.calls).toEqual([]);
  });
});
