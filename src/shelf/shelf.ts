import { bookmarklet, parseFileId } from '../config';
import { runDiagnostics } from '../diag';
import { CONFIRM_CHOICES } from '../confirm';
import { getConfirmMB, setConfirmMB } from '../prefs';
import { CACHE_LIMIT_CHOICES, getBlockStore, getCacheLimitMB, setCacheLimitMB } from '../cache/instance';
import { DriveClient, isFolder, type DriveItem } from '../drive/api';
import { openDrive, type PDFDoc } from '../viewer/source';
import type { BookStates } from '../store/progress';

export interface ShelfInit {
  drive: DriveClient;
  rootFolderId: string;
  states: () => BookStates;
  onOpen: (item: DriveItem) => void;
  onOpenLocal: (file: File) => void;
  onOpenFileId: (fileId: string) => void;
  onSettings: () => void;
  onSignOut: () => void;
}

/** これ以上大きいファイルは、サムネイルが無くても自動では取得しない */
const AUTO_COVER_MAX_BYTES = 30e6;

type Sort = 'recent' | 'name';

export class Shelf {
  readonly el = document.createElement('div');
  private stack: { id: string; name: string }[] = [];
  private items: DriveItem[] = [];
  private query = '';
  private sort: Sort = 'recent';
  private coverQueue: Promise<void> = Promise.resolve();
  /** 保存データがある本（ファイルID → 保存済みバイト数） */
  private saved = new Map<string, number>();

  constructor(private init: ShelfInit) {
    this.el.className = 'shelf';
    this.stack = [{ id: init.rootFolderId, name: 'マイドライブ' }];
    this.renderFrame();
    void this.load();
  }

  private renderFrame(): void {
    this.el.innerHTML = `
      <header class="s-head">
        <h1>書庫</h1>
        <input class="s-search" type="search" placeholder="タイトルで検索" />
        <select class="s-sort" aria-label="並び順">
          <option value="recent">最近読んだ順</option>
          <option value="name">名前順</option>
        </select>
        <label class="s-btn">ファイルを開く<input class="s-file" type="file" accept="application/pdf" hidden /></label>
        <button class="s-btn" data-act="settings">設定</button>
        <button class="s-btn" data-act="signout">ログアウト</button>
      </header>
      <form class="s-url">
        <input class="s-url-in" placeholder="Drive のリンクを貼って開く（https://drive.google.com/file/d/…）" />
        <button class="s-btn">開く</button>
      </form>
      <nav class="s-crumbs"></nav>
      <main class="s-grid"></main>
      <div class="s-msg" hidden></div>
      <footer class="s-foot">
        <details>
          <summary>Drive から 1 クリックで開く（ブックマークレット）</summary>
          <p>次のリンクをブックマークバーへドラッグして保存してください。Drive で PDF を開いた状態でそのブックマークを押すと、この書庫で開きます。</p>
          <p><a class="s-bm" draggable="true">書庫で開く</a></p>
        </details>
        <details class="s-cache">
          <summary>保存データ（再ダウンロードを避ける）</summary>
          <p>一度開いた本のデータをこの端末に保存し、次回は通信せずに読みます。</p>
          <p><label>保存の上限: <select class="s-cache-limit"></select></label></p>
          <p class="s-cache-usage">計算中…</p>
          <p><button class="s-btn" data-act="cache-clear">保存データをすべて削除</button></p>
        </details>
        <details>
          <summary>大きなファイルを開くときの確認</summary>
          <p><label>確認を出すサイズ: <select class="s-confirm"></select></label></p>
        </details>
        <details>
          <summary>通信診断（読み込みが遅いとき）</summary>
          <p>このフォルダの一番大きい PDF で、Drive との通信を測ります（数十秒かかります。通信量は 30MB ほどです）。</p>
          <p><button class="s-btn" data-act="diag">診断を実行</button></p>
          <pre class="s-diag"></pre>
        </details>
      </footer>`;
    const q = this.el.querySelector('.s-search') as HTMLInputElement;
    q.addEventListener('input', () => { this.query = q.value.trim().toLowerCase(); this.renderGrid(); });
    const sort = this.el.querySelector('.s-sort') as HTMLSelectElement;
    sort.addEventListener('change', () => { this.sort = sort.value as Sort; this.renderGrid(); });
    (this.el.querySelector('.s-file') as HTMLInputElement).addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) this.init.onOpenLocal(f);
    });
    const form = this.el.querySelector('.s-url') as HTMLFormElement;
    const urlIn = this.el.querySelector('.s-url-in') as HTMLInputElement;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = parseFileId(urlIn.value);
      if (!id) { this.message('PDFファイルのリンクを貼ってください（フォルダのリンクは使えません）'); return; }
      this.message('');
      this.init.onOpenFileId(id);
    });
    // 現在のアプリのURL（?以降なし）をブックマークレットに埋め込む
    this.el.querySelector('.s-bm')!.setAttribute('href', bookmarklet(location.origin + location.pathname));
    const confirmSel = this.el.querySelector('.s-confirm') as HTMLSelectElement;
    const cur = getConfirmMB();
    for (const mb of [...new Set([...CONFIRM_CHOICES, cur])].sort((a, b) => a - b)) {
      const o = document.createElement('option');
      o.value = String(mb);
      o.textContent = mb === 0 ? '確認しない' : `${mb} MB 以上`;
      o.selected = mb === cur;
      confirmSel.append(o);
    }
    confirmSel.addEventListener('change', () => setConfirmMB(Number(confirmSel.value)));
    const limitSel = this.el.querySelector('.s-cache-limit') as HTMLSelectElement;
    const curLimit = getCacheLimitMB();
    for (const mb of [...new Set([...CACHE_LIMIT_CHOICES, curLimit])].sort((a, b) => a - b)) {
      const o = document.createElement('option');
      o.value = String(mb);
      o.textContent = mb === 0 ? '保存しない' : mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`;
      o.selected = mb === curLimit;
      limitSel.append(o);
    }
    limitSel.addEventListener('change', async () => {
      const mb = Number(limitSel.value);
      setCacheLimitMB(mb);
      const store = await getBlockStore();
      if (store) await (mb === 0 ? store.clear() : store.trim(mb * 1e6));
      void this.refreshCacheInfo();
    });
    this.el.querySelector('[data-act=cache-clear]')!.addEventListener('click', async () => {
      await (await getBlockStore())?.clear();
      void this.refreshCacheInfo();
    });
    void this.refreshCacheInfo();
    this.el.querySelector('[data-act=diag]')!.addEventListener('click', () => void this.diagnose());
    this.el.querySelector('[data-act=settings]')!.addEventListener('click', () => this.init.onSettings());
    this.el.querySelector('[data-act=signout]')!.addEventListener('click', () => this.init.onSignOut());
  }

  /** 保存データの使用量を表示し、各本のカードに「保存済み」の印を付ける */
  private async refreshCacheInfo(): Promise<void> {
    const usage = this.el.querySelector('.s-cache-usage') as HTMLElement | null;
    const store = await getBlockStore();
    if (!usage) return;
    if (!store) { usage.textContent = 'この環境では保存データを使えません'; return; }
    const metas = await store.list();
    const total = metas.reduce((a, m) => a + m.bytes, 0);
    usage.textContent = `使用中: ${(total / 1e6).toFixed(0)} MB（${metas.length} 冊）`;
    this.saved = new Map(metas.map((m) => [m.fileId, m.bytes]));
    this.renderGrid();
  }

  private async diagnose(): Promise<void> {
    const pre = this.el.querySelector('.s-diag') as HTMLElement;
    const target = this.items.filter((i) => !isFolder(i) && i.size).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    if (!target) { pre.textContent = 'このフォルダに PDF がありません'; return; }
    pre.textContent = '測定中…';
    try {
      await runDiagnostics(this.init.drive, target, (t) => { pre.textContent = t; });
    } catch (e) {
      pre.textContent += `\n失敗しました: ${e instanceof Error ? e.message : e}`;
    }
  }

  private message(text: string): void {
    const m = this.el.querySelector('.s-msg') as HTMLElement;
    m.textContent = text;
    m.hidden = !text;
  }

  async load(): Promise<void> {
    this.renderCrumbs();
    this.message('読み込み中…');
    try {
      this.items = await this.init.drive.list(this.stack[this.stack.length - 1].id);
      this.message(this.items.length ? '' : 'このフォルダにPDFはありません');
    } catch (e) {
      this.items = [];
      this.message(e instanceof Error ? e.message : String(e));
    }
    this.renderGrid();
  }

  private renderCrumbs(): void {
    const nav = this.el.querySelector('.s-crumbs') as HTMLElement;
    nav.replaceChildren();
    this.stack.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 's-crumb';
      b.textContent = c.name;
      b.disabled = i === this.stack.length - 1;
      b.addEventListener('click', () => { this.stack = this.stack.slice(0, i + 1); void this.load(); });
      nav.append(b);
      if (i < this.stack.length - 1) nav.append(document.createTextNode(' › '));
    });
  }

  private renderGrid(): void {
    const grid = this.el.querySelector('.s-grid') as HTMLElement;
    grid.replaceChildren();
    const states = this.init.states();
    const match = (i: DriveItem) => !this.query || i.name.toLowerCase().includes(this.query);
    const folders = this.items.filter((i) => isFolder(i) && match(i));
    const books = this.items.filter((i) => !isFolder(i) && match(i));
    if (this.sort === 'recent') {
      books.sort((a, b) => (states[b.id]?.updatedAt ?? 0) - (states[a.id]?.updatedAt ?? 0));
    }
    for (const f of folders) {
      const card = document.createElement('button');
      card.className = 's-card s-folder';
      card.innerHTML = '<div class="s-thumb">📁</div><div class="s-name"></div>';
      (card.querySelector('.s-name') as HTMLElement).textContent = f.name;
      card.addEventListener('click', () => { this.stack.push({ id: f.id, name: f.name }); void this.load(); });
      grid.append(card);
    }
    for (const b of books) grid.append(this.bookCard(b, states[b.id]));
  }

  private bookCard(item: DriveItem, st?: BookStates[string]): HTMLElement {
    const card = document.createElement('button');
    card.className = 's-card';
    card.innerHTML = '<div class="s-thumb"></div><div class="s-name"></div><div class="s-prog"><i></i></div><div class="s-saved" hidden></div>';
    const savedBytes = this.saved.get(item.id);
    if (savedBytes) {
      const badge = card.querySelector('.s-saved') as HTMLElement;
      badge.hidden = false;
      badge.textContent = `保存済み ${(savedBytes / 1e6).toFixed(0)} MB`;
    }
    (card.querySelector('.s-name') as HTMLElement).textContent = item.name.replace(/\.pdf$/i, '');
    const thumb = card.querySelector('.s-thumb') as HTMLElement;
    const fill = card.querySelector('.s-prog i') as HTMLElement;
    const pct = st?.numPages ? Math.min(100, ((st.page + 1) / st.numPages) * 100) : 0;
    fill.style.width = `${pct}%`;
    (card.querySelector('.s-prog') as HTMLElement).hidden = !st?.numPages;

    if (item.thumbnailLink) {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { img.remove(); this.queueCover(item, thumb); };
      img.src = item.thumbnailLink;
      thumb.append(img);
    } else {
      this.queueCover(item, thumb);
    }
    card.addEventListener('click', () => this.init.onOpen(item));
    return card;
  }

  /** サムネイルが無い本は、1ページ目を自前で描画して表紙にする（1冊ずつ順番に） */
  private queueCover(item: DriveItem, thumb: HTMLElement): void {
    // 大きなファイルは、表紙のためだけに数十 MB を勝手に取得しない（開くときに確認する）
    if ((item.size ?? 0) >= AUTO_COVER_MAX_BYTES) { thumb.textContent = 'PDF'; return; }
    const run = async () => {
      if (!thumb.isConnected) return;
      let doc: PDFDoc | undefined;
      const ac = new AbortController();
      try {
        doc = await openDrive(this.init.drive, item.id, item.size, { signal: ac.signal });
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 240 / page.getViewport({ scale: 1 }).width });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
        thumb.replaceChildren(canvas);
      } catch {
        thumb.textContent = 'PDF';
      } finally {
        ac.abort(); // 表紙を取ったら、先読みの通信も止める
        void doc?.destroy();
      }
    };
    this.coverQueue = this.coverQueue.then(run, run);
  }
}
