import { bookmarklet, parseFileId } from '../config';
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

type Sort = 'recent' | 'name';

export class Shelf {
  readonly el = document.createElement('div');
  private stack: { id: string; name: string }[] = [];
  private items: DriveItem[] = [];
  private query = '';
  private sort: Sort = 'recent';
  private coverQueue: Promise<void> = Promise.resolve();

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
    this.el.querySelector('[data-act=settings]')!.addEventListener('click', () => this.init.onSettings());
    this.el.querySelector('[data-act=signout]')!.addEventListener('click', () => this.init.onSignOut());
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
    card.innerHTML = '<div class="s-thumb"></div><div class="s-name"></div><div class="s-prog"><i></i></div>';
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
    const run = async () => {
      if (!thumb.isConnected) return;
      let doc: PDFDoc | undefined;
      try {
        doc = await openDrive(this.init.drive, item.id, item.size);
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
        void doc?.destroy();
      }
    };
    this.coverQueue = this.coverQueue.then(run, run);
  }
}
