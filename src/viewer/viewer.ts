import {
  buildSpreads, isIOS, isWideSize, resolveDouble, spreadIndexOfPage, swipeDir, tapSide, visualOrder,
  type Direction, type SpreadMode,
} from './layout';
import { detectDirection, type PDFDoc } from './source';
import { defaultBookState, type BookState } from '../store/progress';

export interface ViewerInit {
  doc: PDFDoc;
  title: string;
  state: BookState;
  /** 状態が変わったとき（ページ送り・設定変更）に呼ばれる */
  onState: (s: BookState) => void;
  onClose: () => void;
}

const MAX_ZOOM = 5;
const SWIPE_MIN = 50;
const EDGE_OVERSHOOT = 80;
/**
 * iOS（iPhone / iPad の Chrome・Safari も含む）は、キャンバスのメモリ合計に厳しい上限があり、超えると
 * 表示中のキャンバスまで中身が消えて真っ黒になる。そのため iOS では、描画解像度・キャンバス 1 枚の大きさ・
 * 保持する合計（予算）を小さく抑え、先読みも控えめにする。
 */
const LOW_MEM = isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
const MAX_DPR = LOW_MEM ? 2 : 3;
/** キャンバス 1 枚の最大ピクセル数（iOS の上限は約 16.7M） */
const MAX_CANVAS_PIXELS = LOW_MEM ? 5_000_000 : 12_000_000;
/** 保持するキャンバスの合計ピクセル数（4 バイト/ピクセル。iOS 24M = 約 96MB） */
const CANVAS_BUDGET_PX = LOW_MEM ? 24_000_000 : 120_000_000;
/** 先読みするスプレッド（現在位置からの差） */
const PREFETCH_OFFSETS = LOW_MEM ? [1] : [1, -1, 2];
/** 連続でページを送っている間は先読みや全ページの調査を控える */
const IDLE_MS = 300;
/** 現在位置の前後、何スプレッド分の縦横サイズを先に調べるか */
const MEASURE_AHEAD = 6;

/** 描画ジョブ。キャンセルすると、実行中のPDF.js描画も中断する */
interface Job { cancelled: boolean; tasks: Set<{ cancel(): void }> }
const newJob = (): Job => ({ cancelled: false, tasks: new Set() });
function cancelJob(j: Job | null): void {
  if (!j) return;
  j.cancelled = true;
  for (const t of j.tasks) t.cancel();
  j.tasks.clear();
}
class CancelledError extends Error {}
function releaseCanvas(c: HTMLCanvasElement): void {
  if (c.isConnected) return; // 表示中のキャンバスを空にすると、画面が真っ黒になる
  c.width = 0; // GPU/メモリを早めに手放す
  c.height = 0;
}

type Size = { w: number; h: number };

export class Viewer {
  readonly el: HTMLElement;
  /** 最初のページが画面に出たら解決する */
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private loadingEl!: HTMLElement;
  private doc: PDFDoc;
  private state: BookState;
  private onState: (s: BookState) => void;
  private onClose: () => void;

  private stage!: HTMLElement;
  private content!: HTMLElement;
  private ui!: HTMLElement;
  private slider!: HTMLInputElement;
  private pageLabel!: HTMLElement;
  private toast!: HTMLElement;

  private sizes: (Size | undefined)[] = [];
  private spreads: number[][] = [];
  private cur = 0;
  private double = false;
  private direction: Direction = 'ltr';

  private zoom = 1;
  private tx = 0;
  private ty = 0;
  private renderZoom = 1;
  private baseSize: Size = { w: 0, h: 0 };
  /** レイアウトを組んだときの画面サイズ。描画と、キャッシュの鍵はこれを使う（iOS のツールバーの出入りで揺れないように） */
  private viewSize: Size = { w: 0, h: 0 };
  private resizeTimer = 0;
  private cache = new Map<string, HTMLCanvasElement[]>();
  private displayedKey = '';
  private displayJob: Job | null = null;
  private prefetchJob: Job | null = null;
  private showing = false;
  private wantShow: { reset: boolean } | null = null;
  private lastNav = 0;
  private wideCount = 0;
  private measuredCount = 0;
  private zoomTimer = 0;
  private disposed = false;
  private uiVisible = true;

  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private resizeHandler = () => {
    // iOS では、ツールバーの出入りのたびに resize が何度も来る。落ち着いてから、大きく変わったときだけ組み直す
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.disposed) return;
      const r = this.stage.getBoundingClientRect();
      const dw = Math.abs(r.width - this.viewSize.w);
      const dh = Math.abs(r.height - this.viewSize.h);
      if (dw < 2 && dh < Math.max(140, this.viewSize.h * 0.2)) return; // 高さだけの小さな変化（ツールバー）は無視
      this.relayout();
    }, 250);
  };

  constructor(init: ViewerInit) {
    this.doc = init.doc;
    this.state = { ...defaultBookState(), ...init.state };
    this.onState = init.onState;
    this.onClose = init.onClose;
    this.el = document.createElement('div');
    this.el.className = 'viewer';
    this.ready = new Promise((r) => { this.resolveReady = r; });
    this.build(init.title);
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('resize', this.resizeHandler);
    // 開いてしばらくしたら、読書の邪魔にならないようUIを隠す（中央タップで再表示）
    window.setTimeout(() => this.setUiVisible(false), 2500);
    void this.start();
  }

  // ---------- 初期化 ----------
  private async start(): Promise<void> {
    const n = this.doc.numPages;
    this.slider.max = String(Math.max(0, n - 1));
    if (!this.state.direction) {
      this.direction = (await detectDirection(this.doc)) ?? 'ltr';
    } else {
      this.direction = this.state.direction;
    }
    // 先頭ページだけ先に調べてから表示し、残りは裏で調べる
    // 現在のページだけ調べてすぐ表示する。周辺の調査は、表示したあと裏で行う
    const startPage = Math.min(this.state.page, n - 1);
    await this.measure(startPage);
    this.layout(startPage);
    this.requestShow(true);
    // 前回の続きから開いたことを知らせる
    if (startPage > 0) void this.ready.then(() => this.flash(`${(this.spreads[this.cur]?.[0] ?? startPage) + 1} ページから再開しました`));
  }

  private async measure(i: number): Promise<void> {
    if (this.sizes[i]) return;
    const page = await this.doc.getPage(i + 1);
    const v = page.getViewport({ scale: 1 });
    this.sizes[i] = { w: v.width, h: v.height };
    this.measuredCount++;
    if (isWideSize(v.width, v.height)) this.wideCount++;
    page.cleanup();
  }

  /** 縦横が未調査のページは、調査済みのページの多数派と同じとみなす */
  private isWide(i: number): boolean {
    const s = this.sizes[i];
    if (s) return isWideSize(s.w, s.h);
    return this.measuredCount > 0 && this.wideCount * 2 > this.measuredCount;
  }

  /** 指定ページの前後だけ縦横を調べる（全ページを調べると Drive の通信を食うので、読んでいる周辺に限る） */
  private async measureAround(page: number): Promise<void> {
    const n = this.doc.numPages;
    const span = MEASURE_AHEAD * (this.double ? 2 : 1);
    const from = Math.max(0, page - 2);
    const to = Math.min(n - 1, page + span);
    const todo: number[] = [];
    for (let i = from; i <= to; i++) if (!this.sizes[i]) todo.push(i);
    // まとめて依頼すると、PDF.js が取得をまとめてくれる
    await Promise.all(todo.map((i) => this.measure(i).catch(() => undefined)));
  }

  /** 周辺の調査で横長ページが見つかり、組み方が変わるなら、レイアウトを組み直す */
  private async refreshMeasure(): Promise<void> {
    const page = this.spreads[this.cur]?.[0] ?? 0;
    const before = JSON.stringify(this.spreads.slice(Math.max(0, this.cur - 1), this.cur + MEASURE_AHEAD));
    await this.measureAround(page);
    if (this.disposed) return;
    this.el.dataset.measured = 'true';
    const first = this.spreads[this.cur]?.[0] ?? 0;
    if (first !== page) return; // 調べている間に別のページへ移った
    this.layout(page);
    const after = JSON.stringify(this.spreads.slice(Math.max(0, this.cur - 1), this.cur + MEASURE_AHEAD));
    if (before !== after) this.requestShow(false);
  }

  // ---------- レイアウト ----------
  private layout(page: number): void {
    const r = this.stage.getBoundingClientRect();
    this.viewSize = { w: r.width, h: r.height };
    this.double = resolveDouble(this.state.spreadMode, r.width, r.height);
    this.spreads = buildSpreads({
      numPages: this.doc.numPages,
      double: this.double,
      coverSingle: this.state.coverSingle,
      isWide: (i) => this.isWide(i),
    });
    this.cur = spreadIndexOfPage(this.spreads, page);
    this.clearCache();
    this.refreshUi();
  }

  /** 表示するキャンバスを入れ替える。入れ替えで外れた古いキャンバスのうち、キャッシュにも無いものは解放する */
  private swapIn(canvases: HTMLCanvasElement[]): void {
    const old = Array.from(this.content.children) as HTMLCanvasElement[];
    this.content.replaceChildren(...canvases);
    const keep = new Set<HTMLCanvasElement>(canvases);
    for (const cs of this.cache.values()) cs.forEach((c) => keep.add(c));
    for (const c of old) if (!keep.has(c)) releaseCanvas(c);
  }

  private clearCache(): void {
    for (const c of this.cache.values()) c.forEach(releaseCanvas);
    this.cache.clear();
    this.displayedKey = '';
  }

  private relayout(): void {
    const page = this.spreads[this.cur]?.[0] ?? this.state.page;
    this.layout(page);
    this.requestShow(true);
  }

  // ---------- 描画 ----------
  /**
   * 表示の更新を依頼する。描画中に何度依頼されても、描画が終わったあとに「最新のスプレッド」を1回だけ描く。
   * 古い描画は中断するので、連続でページを送っても処理が積み上がらない。
   */
  private requestShow(resetView: boolean): void {
    this.lastNav = performance.now();
    cancelJob(this.prefetchJob);
    // 描画中のスプレッドがもう古いなら、描画を中断して最新のものに切り替える
    cancelJob(this.displayJob);
    this.wantShow = { reset: resetView || (this.wantShow?.reset ?? false) };
    if (!this.showing) void this.runShow();
  }

  private async runShow(): Promise<void> {
    this.showing = true;
    try {
      while (this.wantShow && !this.disposed) {
        const { reset } = this.wantShow;
        this.wantShow = null;
        await this.showOnce(reset);
      }
    } finally {
      this.showing = false;
    }
    if (!this.disposed) this.afterIdle();
  }

  private async showOnce(resetView: boolean): Promise<void> {
    const spread = this.cur;
    if (resetView) { this.zoom = 1; this.tx = 0; this.ty = 0; this.renderZoom = 1; }
    const job = newJob();
    this.displayJob = job;
    let canvases: HTMLCanvasElement[] | null = null;
    try {
      canvases = await this.getSpreadCanvases(spread, this.renderZoom, job);
    } catch (e) {
      console.error('ページの描画に失敗しました', e);
    }
    if (this.displayJob === job) this.displayJob = null;
    if (!canvases || job.cancelled || spread !== this.cur || this.disposed) return;
    this.displayedKey = this.cacheKey(spread, this.renderZoom);
    this.swapIn(canvases);
    this.applyTransform();
    this.refreshUi();
    // 実際に画面に出ているページ（テストや診断用）
    this.el.dataset.shown = String(this.spreads[spread]?.[0] ?? 0);
    this.loadingEl.hidden = true;
    this.resolveReady();
  }

  /** 操作が落ち着いたら、周辺の調査と先読みを始める */
  private afterIdle(): void {
    const wait = Math.max(0, IDLE_MS - (performance.now() - this.lastNav));
    window.setTimeout(() => {
      if (this.disposed || this.showing || performance.now() - this.lastNav < IDLE_MS - 20) return;
      void this.refreshMeasure().then(() => this.prefetch());
    }, wait);
  }

  private cacheKey(spread: number, rz: number): string {
    return `${spread}:${rz}:${Math.round(this.viewSize.w)}x${Math.round(this.viewSize.h)}:${this.double}:${this.direction}`;
  }

  /** 指定スプレッドのキャンバスを返す。キャンセルされたら null */
  private async getSpreadCanvases(spread: number, rz: number, job: Job): Promise<HTMLCanvasElement[] | null> {
    const key = this.cacheKey(spread, rz);
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }

    const pages = visualOrder(this.spreads[spread] ?? [], this.direction);
    await Promise.all(pages.map((p) => this.measure(p)));
    if (job.cancelled) return null;
    const sizes = pages.map((p) => this.sizes[p]!);
    const totalW = sizes.reduce((a, s) => a + s.w, 0);
    const maxH = Math.max(...sizes.map((s) => s.h));
    const fit = Math.min(this.viewSize.w / totalW, this.viewSize.h / maxH);
    if (spread === this.cur) this.baseSize = { w: totalW * fit, h: maxH * fit };

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    try {
      const canvases = await Promise.all(pages.map(async (p, i) => {
        const page = await this.doc.getPage(p + 1);
        if (job.cancelled) throw new CancelledError();
        const s = sizes[i];
        let scale = fit * dpr * rz;
        const px = s.w * scale * s.h * scale;
        if (px > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / px);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${s.w * fit}px`;
        canvas.style.height = `${s.h * fit}px`;
        const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, background: '#fff' });
        job.tasks.add(task);
        try {
          await task.promise;
        } catch (e) {
          if ((e as { name?: string })?.name === 'RenderingCancelledException') throw new CancelledError();
          throw e;
        } finally {
          job.tasks.delete(task);
          page.cleanup(); // 画像のデコード結果などを解放して、メモリの膨張を防ぐ
        }
        return canvas;
      }));
      if (job.cancelled) { canvases.forEach(releaseCanvas); return null; }
      this.cache.set(key, canvases);
      this.evict();
      return canvases;
    } catch (e) {
      if (e instanceof CancelledError) return null;
      throw e;
    }
  }

  /** キャッシュの合計ピクセル数 */
  private cachedPixels(): number {
    let n = 0;
    for (const cs of this.cache.values()) for (const c of cs) n += c.width * c.height;
    return n;
  }

  /** キャッシュの合計が予算を超えたら、古いものから捨てる（表示中のものは残す）。キャンバスのメモリも明示的に解放する */
  private evict(): void {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= 1 || this.cachedPixels() <= CANVAS_BUDGET_PX) break;
      if (key === this.displayedKey) continue;
      this.cache.get(key)!.forEach(releaseCanvas);
      this.cache.delete(key);
    }
    this.el.dataset.canvasMpx = (this.cachedPixels() / 1e6).toFixed(1);
  }

  /** 前後のスプレッドを先に描画しておく（操作が始まったら中断する） */
  private async prefetch(): Promise<void> {
    cancelJob(this.prefetchJob);
    const job = newJob();
    this.prefetchJob = job;
    for (const d of PREFETCH_OFFSETS) {
      if (job.cancelled || this.disposed) return;
      const idx = this.cur + d;
      if (idx < 0 || idx >= this.spreads.length) continue;
      try { await this.getSpreadCanvases(idx, 1, job); } catch { /* 先読みの失敗は無視 */ }
    }
  }

  private applyTransform(): void {
    this.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
  }

  private clampPan(): { overX: number; overY: number } {
    const r = this.stage.getBoundingClientRect();
    const w = this.baseSize.w * this.zoom;
    const h = this.baseSize.h * this.zoom;
    const limX = Math.max(0, (w - r.width) / 2);
    const limY = Math.max(0, (h - r.height) / 2);
    const overX = Math.abs(this.tx) > limX ? this.tx - Math.sign(this.tx) * limX : 0;
    const overY = Math.abs(this.ty) > limY ? this.ty - Math.sign(this.ty) * limY : 0;
    this.tx = Math.max(-limX, Math.min(limX, this.tx));
    this.ty = Math.max(-limY, Math.min(limY, this.ty));
    return { overX, overY };
  }

  /** ズームが落ち着いたら、その倍率で描き直して文字をくっきりさせる */
  private scheduleSharpen(): void {
    window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(async () => {
      if (this.disposed || this.zoom <= 1.05) return;
      const rz = Math.min(this.zoom, 4);
      if (Math.abs(rz - this.renderZoom) < 0.25) return;
      const spread = this.cur;
      const job = newJob();
      cancelJob(this.prefetchJob);
      this.prefetchJob = job; // 拡大の描き直しも、操作が始まれば中断する
      let canvases: HTMLCanvasElement[] | null = null;
      try { canvases = await this.getSpreadCanvases(spread, rz, job); } catch { return; }
      if (!canvases || job.cancelled || spread !== this.cur || this.disposed || this.showing) return;
      // 描き直した分、CSSの倍率は掛け直さない（CSSサイズは常に等倍）
      this.renderZoom = rz;
      this.displayedKey = this.cacheKey(spread, rz);
      this.swapIn(canvases);
      this.applyTransform();
    }, 250);
  }

  // ---------- ページ送り ----------
  private go(dir: 'next' | 'prev'): void {
    const idx = this.cur + (dir === 'next' ? 1 : -1);
    if (idx < 0 || idx >= this.spreads.length) {
      this.flash(idx < 0 ? '最初のページです' : '最後のページです');
      return;
    }
    this.jumpSpread(idx);
  }

  private jumpSpread(idx: number): void {
    this.cur = Math.max(0, Math.min(this.spreads.length - 1, idx));
    this.persist();
    this.refreshUi();
    this.requestShow(true);
  }

  private jumpPage(page: number): void {
    this.jumpSpread(spreadIndexOfPage(this.spreads, page));
  }

  private persist(): void {
    this.state = {
      ...this.state,
      page: this.spreads[this.cur]?.[0] ?? 0,
      numPages: this.doc.numPages,
      direction: this.direction,
      updatedAt: Date.now(),
    };
    this.onState(this.state);
  }

  // ---------- UI ----------
  private build(title: string): void {
    this.el.innerHTML = `
      <div class="v-stage"><div class="v-content"></div></div>
      <div class="v-ui">
        <div class="v-top">
          <button class="v-btn" data-act="close" aria-label="本棚へ戻る">‹ 本棚</button>
          <div class="v-title"></div>
          <button class="v-btn" data-act="dir" title="綴じ方向"></button>
          <button class="v-btn" data-act="mode" title="見開き"></button>
          <button class="v-btn" data-act="cover" title="表紙を単独表示"></button>
        </div>
        <div class="v-bottom">
          <span class="v-page"></span>
          <input class="v-slider" type="range" min="0" value="0" aria-label="ページ" />
        </div>
      </div>
      <div class="v-loading"><div class="v-spinner"></div><div class="v-loading-text">最初のページを描画しています…</div></div>
      <div class="v-toast" hidden></div>`;
    this.loadingEl = this.el.querySelector('.v-loading')!;
    this.stage = this.el.querySelector('.v-stage')!;
    this.content = this.el.querySelector('.v-content')!;
    this.ui = this.el.querySelector('.v-ui')!;
    this.slider = this.el.querySelector('.v-slider')!;
    this.pageLabel = this.el.querySelector('.v-page')!;
    this.toast = this.el.querySelector('.v-toast')!;
    (this.el.querySelector('.v-title') as HTMLElement).textContent = title;

    this.el.querySelector('[data-act=close]')!.addEventListener('click', () => this.onClose());
    this.el.querySelector('[data-act=dir]')!.addEventListener('click', () => {
      this.direction = this.direction === 'rtl' ? 'ltr' : 'rtl';
      this.clearCache();
      this.persist();
      this.refreshUi();
      this.requestShow(true);
    });
    this.el.querySelector('[data-act=mode]')!.addEventListener('click', () => {
      const order: SpreadMode[] = ['auto', 'double', 'single'];
      this.state.spreadMode = order[(order.indexOf(this.state.spreadMode) + 1) % order.length];
      this.relayout();
      this.persist();
    });
    this.el.querySelector('[data-act=cover]')!.addEventListener('click', () => {
      this.state.coverSingle = !this.state.coverSingle;
      this.relayout();
      this.persist();
    });
    this.slider.addEventListener('input', () => {
      const v = Number(this.slider.value);
      // スライダーは読む方向に合わせて動く（右開きなら右端が先頭）
      this.pageLabel.textContent = this.labelFor(v);
    });
    this.slider.addEventListener('change', () => this.jumpPage(Number(this.slider.value)));
    this.slider.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bindGestures();
  }

  /** 最初のページが出るまでの、読み込み状況の表示を更新する */
  setStatus(text: string): void {
    const t = this.loadingEl.querySelector('.v-loading-text');
    if (t) t.textContent = text;
  }

  private labelFor(page: number): string {
    return `${page + 1} / ${this.doc.numPages}`;
  }

  private refreshUi(): void {
    const sp = this.spreads[this.cur] ?? [];
    const first = sp[0] ?? 0;
    const last = sp[sp.length - 1] ?? first;
    this.pageLabel.textContent =
      sp.length > 1 ? `${first + 1}-${last + 1} / ${this.doc.numPages}` : this.labelFor(first);
    this.slider.value = String(first);
    this.slider.style.direction = this.direction === 'rtl' ? 'rtl' : 'ltr';
    const modeText = { auto: '自動', double: '見開き', single: '単ページ' }[this.state.spreadMode];
    const set = (act: string, text: string) => {
      (this.el.querySelector(`[data-act=${act}]`) as HTMLElement).textContent = text;
    };
    set('dir', this.direction === 'rtl' ? '右開き' : '左開き');
    set('mode', modeText);
    set('cover', this.state.coverSingle ? '表紙:単独' : '表紙:並べる');
    (this.el.querySelector('[data-act=cover]') as HTMLElement).hidden = !this.double;
    this.el.dataset.direction = this.direction;
    this.el.dataset.double = String(this.double);
    this.el.dataset.page = String(first);
  }

  private setUiVisible(v: boolean): void {
    this.uiVisible = v;
    this.ui.classList.toggle('hidden', !v);
  }

  private flash(msg: string): void {
    this.toast.textContent = msg;
    this.toast.hidden = false;
    window.setTimeout(() => { this.toast.hidden = true; }, 1200);
  }

  // ---------- 入力 ----------
  private onKey(e: KeyboardEvent): void {
    if (this.disposed || (e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    const keyDir = (side: 'left' | 'right') => tapSide(side, this.direction);
    switch (e.key) {
      case 'ArrowLeft': this.go(keyDir('left')); break;
      case 'ArrowRight': this.go(keyDir('right')); break;
      case 'PageDown': case ' ': this.go(e.shiftKey ? 'prev' : 'next'); break;
      case 'PageUp': this.go('prev'); break;
      case 'Home': this.jumpSpread(0); break;
      case 'End': this.jumpSpread(this.spreads.length - 1); break;
      case 'Escape': this.onClose(); break;
      case '+': case '=': this.zoomAt(this.zoom * 1.25, 0, 0); break;
      case '-': this.zoomAt(this.zoom / 1.25, 0, 0); break;
      case '0': this.zoomAt(1, 0, 0); break;
      default: return;
    }
    e.preventDefault();
  }

  /** (cx, cy) はステージ中心からの相対座標。そこを不動点にして拡大縮小する */
  private zoomAt(next: number, cx: number, cy: number): void {
    const z = Math.max(1, Math.min(MAX_ZOOM, next));
    const k = z / this.zoom;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.zoom = z;
    this.clampPan();
    this.applyTransform();
    this.scheduleSharpen();
  }

  private bindGestures(): void {
    const pointers = new Map<number, { x: number; y: number }>();
    let start = { x: 0, y: 0, t: 0, tx: 0, ty: 0 };
    let moved = false;
    let pinch: { dist: number; zoom: number } | null = null;
    let lastTap = 0;

    const center = (e: { clientX: number; clientY: number }) => {
      const r = this.stage.getBoundingClientRect();
      return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2, r };
    };

    this.stage.addEventListener('pointerdown', (e) => {
      this.stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        start = { x: e.clientX, y: e.clientY, t: performance.now(), tx: this.tx, ty: this.ty };
        moved = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
        moved = true;
      }
    });

    this.stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const c = center({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        this.zoomAt(pinch.zoom * (d / pinch.dist), c.x, c.y);
        return;
      }
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (this.zoom > 1 && pointers.size === 1) {
        this.tx = start.tx + dx;
        this.ty = start.ty + dy;
        this.applyTransform();
      }
    });

    const end = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const wasPinch = pointers.size >= 2;
      pointers.delete(e.pointerId);
      if (wasPinch) { if (pointers.size < 2) pinch = null; return; }

      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const dt = performance.now() - start.t;

      if (this.zoom > 1) {
        // 拡大中: 端を越えて引っ張ったらページを送る
        this.tx = start.tx + dx;
        this.ty = start.ty + dy;
        const { overX } = this.clampPan();
        this.applyTransform();
        if (moved && Math.abs(overX) > EDGE_OVERSHOOT) this.go(swipeDir(dx, this.direction));
        else if (!moved) this.handleTap(e, () => lastTap, (t) => { lastTap = t; });
        return;
      }
      if (moved && Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
        this.go(swipeDir(dx, this.direction));
        return;
      }
      if (!moved) this.handleTap(e, () => lastTap, (t) => { lastTap = t; });
    };
    this.stage.addEventListener('pointerup', end);
    this.stage.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; });

    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const c = center(e);
        this.zoomAt(this.zoom * Math.exp(-e.deltaY * 0.01), c.x, c.y);
      } else if (this.zoom > 1) {
        this.tx -= e.deltaX;
        this.ty -= e.deltaY;
        this.clampPan();
        this.applyTransform();
      }
    }, { passive: false });
  }

  private handleTap(e: PointerEvent, getLast: () => number, setLast: (t: number) => void): void {
    const now = performance.now();
    const c = this.stageCenter(e);
    if (now - getLast() < 300) {
      setLast(0);
      this.zoomAt(this.zoom > 1.05 ? 1 : 2.5, c.x, c.y);
      return;
    }
    setLast(now);
    // ダブルタップかどうかを見極めてから、ページ送り/UI切り替えを実行する
    window.setTimeout(() => {
      if (getLast() !== now) return;
      setLast(0);
      const ratio = (e.clientX - c.left) / c.width;
      if (this.zoom > 1.05) this.setUiVisible(!this.uiVisible);
      else if (ratio < 0.3) this.go(tapSide('left', this.direction));
      else if (ratio > 0.7) this.go(tapSide('right', this.direction));
      else this.setUiVisible(!this.uiVisible);
    }, 310);
  }

  private stageCenter(e: PointerEvent): { x: number; y: number; left: number; width: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2, left: r.left, width: r.width };
  }

  dispose(): void {
    this.disposed = true;
    cancelJob(this.displayJob);
    cancelJob(this.prefetchJob);
    window.clearTimeout(this.zoomTimer);
    window.clearTimeout(this.resizeTimer);
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('resize', this.resizeHandler);
    void this.doc.destroy();
  }
}
