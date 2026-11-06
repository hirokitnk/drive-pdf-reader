// ブロック単位の並列・先読み取得。
// Drive の範囲取得は、サイズに関係なく 1 回ごとに約 2.5 秒の待ちがあり、並列にはほぼ線形に伸びる。
// PDF.js は小さな読み込みを順番に繰り返すため、そのまま渡すと待ちが積み重なる。
// そこで、(1) 大きなブロック単位で取り、(2) 要求されたブロックを最優先に、(3) 周辺を並列に先読みする。
//
// PDF.js は、自分が要求した範囲（先頭位置が一致するもの）への返答しか受け付けない。
// そのため先読みしたブロックは自前のキャッシュに置き、要求が来たら、その範囲ぴったりに切り出して返す。

export interface BlockLoaderOptions {
  /** ファイル全体のバイト数 */
  size: number;
  /** ブロックの大きさ（PDF.js のチャンクサイズの倍数にすること） */
  blockSize: number;
  /** 同時に取得する数 */
  concurrency: number;
  /** 要求された位置の先を、何ブロックまで先読みするか */
  readAhead: number;
  /** キャッシュに置くブロック数の上限（メモリの上限） */
  maxCachedBlocks: number;
  fetchBlock: (begin: number, endExclusive: number) => Promise<Uint8Array>;
  /** 要求された範囲 [begin, end) のデータを PDF.js へ返す */
  deliver: (begin: number, chunk: Uint8Array) => void;
  /** 要求されたブロックが、再試行しても取得できなかった */
  onError: (e: Error) => void;
  retries?: number;
  retryDelayMs?: number;
}

interface Demand { begin: number; end: number; first: number; last: number }

const NONE = 0, LOADING = 1, CACHED = 2;

export class BlockLoader {
  private readonly o: Required<BlockLoaderOptions>;
  private readonly numBlocks: number;
  private state: Uint8Array;
  private cache = new Map<number, Uint8Array>();
  /** 一度でも PDF.js へ渡したブロック（キャッシュが増えたとき、先に捨てる） */
  private used = new Set<number>();
  /** PDF.js が初期データとして持っているブロック。再取得も先読みもしない */
  private held = new Set<number>();
  private inflight = 0;
  private demands: Demand[] = [];
  private demandQueue: number[] = [];
  private wanted = new Set<number>();
  private failed = new Set<number>();
  private lastDemand = 0;
  /** 最初に先読みしておくブロック（先頭の続きと、構造情報のある末尾） */
  private initial: number[] = [];
  private stopped = false;

  constructor(o: BlockLoaderOptions) {
    this.o = { retries: 2, retryDelayMs: 500, ...o };
    this.numBlocks = Math.max(1, Math.ceil(o.size / o.blockSize));
    this.state = new Uint8Array(this.numBlocks);
    this.initial = [this.numBlocks - 1, 1, 2];
  }

  /** PDF.js が初期データとして持っているブロックを登録する */
  hold(block: number): void {
    if (block >= 0 && block < this.numBlocks) this.held.add(block);
  }

  /** すでに取得したブロックを受け取る（開くときに先頭と末尾を同時に取った場合など） */
  provide(block: number, data: Uint8Array): void {
    if (this.stopped || this.state[block] === CACHED) return;
    this.store(block, data);
    this.flush();
  }

  /** PDF.js からの要求。含まれるブロックを最優先で取る */
  demand(begin: number, endExclusive: number): void {
    if (this.stopped) return;
    const first = Math.floor(begin / this.o.blockSize);
    const last = Math.min(this.numBlocks - 1, Math.floor((endExclusive - 1) / this.o.blockSize));
    this.demands.push({ begin, end: endExclusive, first, last });
    for (let b = first; b <= last; b++) {
      if (this.state[b] === CACHED) continue;
      this.wanted.add(b);
      if (this.state[b] === NONE && !this.demandQueue.includes(b)) {
        this.failed.delete(b); // 要求されたら、以前の失敗に関係なくもう一度試す
        this.demandQueue.push(b);
      }
    }
    this.lastDemand = last;
    this.flush();
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.demandQueue = [];
    this.demands = [];
    this.cache.clear();
  }

  /** 取得済み・取得中のブロック数（診断用） */
  stats(): { cached: number; loading: number; total: number } {
    let cached = 0, loading = 0;
    for (const s of this.state) { if (s === CACHED) cached++; else if (s === LOADING) loading++; }
    return { cached, loading, total: this.numBlocks };
  }

  private store(block: number, data: Uint8Array): void {
    this.cache.set(block, data);
    this.state[block] = CACHED;
    this.evict();
  }

  /** キャッシュが上限を超えたら、渡し済みのものを古い順に、それでも足りなければ古い順に捨てる */
  private evict(): void {
    const protect = new Set<number>();
    for (const d of this.demands) for (let b = d.first; b <= d.last; b++) protect.add(b);
    const drop = (pred: (b: number) => boolean) => {
      for (const b of this.cache.keys()) {
        if (this.cache.size <= this.o.maxCachedBlocks) return;
        if (!pred(b)) continue;
        this.cache.delete(b);
        this.used.delete(b);
        this.state[b] = NONE;
      }
    };
    drop((b) => this.used.has(b) && !protect.has(b));
    drop((b) => !protect.has(b));
  }

  /** 揃った要求に返答する */
  private flush(): void {
    const rest: Demand[] = [];
    for (const d of this.demands) {
      let ready = true;
      for (let b = d.first; b <= d.last; b++) if (!this.cache.has(b)) { ready = false; break; }
      if (!ready) { rest.push(d); continue; }
      this.deliver(d);
    }
    this.demands = rest;
  }

  private deliver(d: Demand): void {
    const bs = this.o.blockSize;
    let out: Uint8Array;
    if (d.first === d.last) {
      const base = d.first * bs;
      out = this.cache.get(d.first)!.subarray(d.begin - base, d.end - base);
    } else {
      out = new Uint8Array(d.end - d.begin);
      let off = 0;
      for (let b = d.first; b <= d.last; b++) {
        const base = b * bs;
        const data = this.cache.get(b)!;
        const from = Math.max(d.begin, base) - base;
        const to = Math.min(d.end, base + data.length) - base;
        out.set(data.subarray(from, to), off);
        off += to - from;
      }
    }
    for (let b = d.first; b <= d.last; b++) this.used.add(b);
    this.o.deliver(d.begin, out);
  }

  /** 先読みしておくブロックを探す（要求されたものが無いときに使う） */
  private nextBackground(): number | undefined {
    const free = (b: number) =>
      b >= 0 && b < this.numBlocks && this.state[b] === NONE && !this.failed.has(b) && !this.held.has(b);
    for (const b of this.initial) if (free(b)) return b;
    for (let k = 1; k <= this.o.readAhead; k++) if (free(this.lastDemand + k)) return this.lastDemand + k;
    for (let k = 1; k <= 2; k++) if (free(this.lastDemand - k)) return this.lastDemand - k;
    return undefined;
  }

  private pump(): void {
    while (!this.stopped && this.inflight < this.o.concurrency) {
      let b = this.demandQueue.shift();
      if (b === undefined) b = this.nextBackground();
      if (b === undefined) return;
      if (this.state[b] !== NONE) continue;
      void this.load(b);
    }
  }

  private async load(b: number): Promise<void> {
    this.state[b] = LOADING;
    this.inflight++;
    const begin = b * this.o.blockSize;
    const end = Math.min(this.o.size, begin + this.o.blockSize);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.o.retries && !this.stopped; attempt++) {
      try {
        const data = await this.o.fetchBlock(begin, end);
        if (this.stopped) { this.inflight--; return; }
        this.wanted.delete(b);
        this.store(b, data);
        this.inflight--;
        this.flush();
        this.pump();
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < this.o.retries) await new Promise((r) => setTimeout(r, this.o.retryDelayMs * (attempt + 1)));
      }
    }
    this.state[b] = NONE;
    this.failed.add(b);
    this.inflight--;
    if (!this.stopped && this.wanted.has(b) && lastError) this.o.onError(lastError);
    this.pump();
  }
}
