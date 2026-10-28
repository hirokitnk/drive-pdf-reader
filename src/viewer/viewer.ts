import {
  buildSpreads, isWideSize, resolveDouble, spreadIndexOfPage, swipeDir, tapSide, visualOrder,
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
const CACHE_SIZE = 6;
const MAX_CANVAS_PIXELS = 16_000_000;

type Size = { w: number; h: number };

export class Viewer {
  readonly el: HTMLElement;
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
  private renderToken = 0;
  private cache = new Map<string, HTMLCanvasElement[]>();
  private zoomTimer = 0;
  private disposed = false;
  private uiVisible = true;

  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private resizeHandler = () => this.relayout();

  constructor(init: ViewerInit) {
    this.doc = init.doc;
    this.state = { ...defaultBookState(), ...init.state };
    this.onState = init.onState;
    this.onClose = init.onClose;
    this.el = document.createElement('div');
    this.el.className = 'viewer';
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
    await this.measure(0);
    this.layout(Math.min(this.state.page, n - 1));
    await this.show();
    void this.measureAll();
  }

  private async measure(i: number): Promise<void> {
    if (this.sizes[i]) return;
    const page = await this.doc.getPage(i + 1);
    const v = page.getViewport({ scale: 1 });
    this.sizes[i] = { w: v.width, h: v.height };
  }

  /** 全ページの縦横を裏で調べる。横長ページが見つかったらレイアウトを組み直す */
  private async measureAll(): Promise<void> {
    const n = this.doc.numPages;
    let changed = false;
    const wasWide = (i: number) => { const s = this.sizes[i]; return !!s && isWideSize(s.w, s.h); };
    for (let i = 0; i < n && !this.disposed; i++) {
      const before = wasWide(i);
      const had = !!this.sizes[i];
      try { await this.measure(i); } catch { return; }
      if (!had && wasWide(i) !== before) changed = true;
      if (changed && (i % 20 === 19 || i === n - 1)) {
        changed = false;
        const page = this.spreads[this.cur]?.[0] ?? 0;
        this.layout(page);
        void this.show(false);
      }
    }
    // 全ページの縦横が分かった（レイアウトが確定した）
    this.el.dataset.measured = 'true';
  }

  // ---------- レイアウト ----------
  private layout(page: number): void {
    const r = this.stage.getBoundingClientRect();
    this.double = resolveDouble(this.state.spreadMode, r.width, r.height);
    this.spreads = buildSpreads({
      numPages: this.doc.numPages,
      double: this.double,
      coverSingle: this.state.coverSingle,
      isWide: (i) => { const s = this.sizes[i]; return !!s && isWideSize(s.w, s.h); },
    });
    this.cur = spreadIndexOfPage(this.spreads, page);
    this.cache.clear();
    this.refreshUi();
  }

  private relayout(): void {
    const page = this.spreads[this.cur]?.[0] ?? this.state.page;
    this.layout(page);
    void this.show();
  }

  // ---------- 描画 ----------
  private async show(resetView = true): Promise<void> {
    const token = ++this.renderToken;
    if (resetView) { this.zoom = 1; this.tx = 0; this.ty = 0; this.renderZoom = 1; }
    const canvases = await this.getSpreadCanvases(this.cur, this.renderZoom);
    if (token !== this.renderToken || this.disposed) return;
    this.content.replaceChildren(...canvases);
    this.applyTransform();
    this.refreshUi();
    void this.prefetch(token);
  }

  private cacheKey(spread: number, rz: number): string {
    const r = this.stage.getBoundingClientRect();
    return `${spread}:${rz}:${Math.round(r.width)}x${Math.round(r.height)}:${this.double}:${this.direction}`;
  }

  private async getSpreadCanvases(spread: number, rz: number): Promise<HTMLCanvasElement[]> {
    const key = this.cacheKey(spread, rz);
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }

    const pages = visualOrder(this.spreads[spread] ?? [], this.direction);
    await Promise.all(pages.map((p) => this.measure(p)));
    const sizes = pages.map((p) => this.sizes[p]!);
    const totalW = sizes.reduce((a, s) => a + s.w, 0);
    const maxH = Math.max(...sizes.map((s) => s.h));
    const r = this.stage.getBoundingClientRect();
    const fit = Math.min(r.width / totalW, r.height / maxH);
    this.baseSize = { w: totalW * fit, h: maxH * fit };

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const canvases = await Promise.all(pages.map(async (p, i) => {
      const page = await this.doc.getPage(p + 1);
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
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, background: '#fff' }).promise;
      return canvas;
    }));
    this.cache.set(key, canvases);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return canvases;
  }

  /** 前後のスプレッドを先に描画しておく */
  private async prefetch(token: number): Promise<void> {
    for (const d of [1, -1, 2]) {
      if (token !== this.renderToken || this.disposed) return;
      const idx = this.cur + d;
      if (idx < 0 || idx >= this.spreads.length) continue;
      try { await this.getSpreadCanvases(idx, 1); } catch { /* 先読み失敗は無視 */ }
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
      const token = this.renderToken;
      const canvases = await this.getSpreadCanvases(this.cur, rz);
      if (token !== this.renderToken || this.disposed) return;
      // 描き直した分、CSSの倍率は掛け直さない（CSSサイズは常に等倍）
      this.renderZoom = rz;
      this.content.replaceChildren(...canvases);
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
    void this.show();
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
      <div class="v-toast" hidden></div>`;
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
      this.cache.clear();
      this.persist();
      void this.show();
      this.refreshUi();
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
    window.clearTimeout(this.zoomTimer);
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('resize', this.resizeHandler);
    void this.doc.destroy();
  }
}
