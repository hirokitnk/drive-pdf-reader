import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BlockStore, fileCacheKey } from '../src/cache/store';

const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);
let store: BlockStore;

beforeEach(async () => {
  store = (await BlockStore.open())!;
  await store.clear();
});

describe('BlockStore', () => {
  it('保存したブロックを、中身ごと返す', async () => {
    const data = Uint8Array.from({ length: 100 }, (_, i) => i);
    await store.put('a@1', 0, data, { fileId: 'a', name: 'A' });
    const got = await store.get('a@1', 0, 100);
    expect(Array.from(got!)).toEqual(Array.from(data));
  });

  it('ビューの一部だけを渡しても、その範囲だけを保存する', async () => {
    const big = Uint8Array.from({ length: 200 }, (_, i) => i);
    await store.put('a@1', 0, big.subarray(50, 80), { fileId: 'a', name: 'A' });
    expect(Array.from((await store.get('a@1', 0, 30))!)).toEqual(Array.from(big.subarray(50, 80)));
  });

  it('無いもの・長さが違うものは null', async () => {
    expect(await store.get('a@1', 0, 10)).toBeNull();
    await store.put('a@1', 0, bytes(10), { fileId: 'a', name: 'A' });
    expect(await store.get('a@1', 0, 11)).toBeNull();
    expect(await store.get('a@1', 1, 10)).toBeNull();
  });

  it('版（キー）が違えば、別のファイルとして扱う', async () => {
    await store.put(fileCacheKey('a', '2026-01-01'), 0, bytes(10), { fileId: 'a', name: 'A' });
    expect(await store.get(fileCacheKey('a', '2026-02-02'), 0, 10)).toBeNull();
  });

  it('合計バイト数とブロック数を数える（同じブロックの上書きは二重に数えない）', async () => {
    await store.put('a@1', 0, bytes(10), { fileId: 'a', name: 'A' });
    await store.put('a@1', 1, bytes(20), { fileId: 'a', name: 'A' });
    await store.put('a@1', 1, bytes(20, 9), { fileId: 'a', name: 'A' });
    expect(await store.cachedBytes('a@1')).toBe(30);
    expect((await store.list())[0].blocks).toBe(2);
    expect(await store.totalBytes()).toBe(30);
  });

  it('ファイルを消すと、そのファイルのブロックだけが消える（前方一致の取り違えがない）', async () => {
    await store.put('a@1', 0, bytes(10), { fileId: 'a', name: 'A' });
    await store.put('a@1', 10, bytes(10), { fileId: 'a', name: 'A' });
    await store.put('a@10', 0, bytes(10), { fileId: 'a', name: 'A' }); // キーが前方一致する別の版
    await store.removeFile('a@1');
    expect(await store.get('a@1', 0, 10)).toBeNull();
    expect(await store.get('a@1', 10, 10)).toBeNull();
    expect(await store.get('a@10', 0, 10)).not.toBeNull();
  });

  it('古い版を消す', async () => {
    await store.put('a@old', 0, bytes(10), { fileId: 'a', name: 'A' });
    await store.put('b@1', 0, bytes(10), { fileId: 'b', name: 'B' });
    await store.put('a@new', 0, bytes(10), { fileId: 'a', name: 'A' });
    await store.removeOtherVersions('a', 'a@new');
    expect((await store.list()).map((m) => m.key).sort()).toEqual(['a@new', 'b@1']);
  });

  it('上限を超えたら、最後に使ったのが古いファイルから消す。使用中のファイルは消さない', async () => {
    await store.put('old@1', 0, bytes(100), { fileId: 'old', name: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    await store.put('mid@1', 0, bytes(100), { fileId: 'mid', name: 'mid' });
    await new Promise((r) => setTimeout(r, 5));
    await store.put('new@1', 0, bytes(100), { fileId: 'new', name: 'new' });
    await new Promise((r) => setTimeout(r, 5));
    await store.touch('old@1'); // old を使った → 一番新しくなる
    const removed = await store.trim(150, 'old@1');
    expect(removed).toBe(2);
    expect((await store.list()).map((m) => m.key)).toEqual(['old@1']);
  });

  it('上限以内なら何も消さない', async () => {
    await store.put('a@1', 0, bytes(100), { fileId: 'a', name: 'A' });
    expect(await store.trim(1000)).toBe(0);
  });
});
