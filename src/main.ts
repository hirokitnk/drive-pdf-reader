import './style.css';
import { fileIdFromLocation, loadConfig, parseFolderId, saveConfig, type Config } from './config';
import { getToken, hasSignedInBefore, signOut } from './drive/auth';
import { DriveClient, type DriveItem } from './drive/api';
import { Shelf } from './shelf/shelf';
import { StateStore } from './sync';
import { Viewer } from './viewer/viewer';
import { openDrive, openLocal, type LoadProgress, type PDFDoc } from './viewer/source';
import { defaultBookState } from './store/progress';
import { confirmLargeOpen } from './confirm';
import { addHistory, getConfirmMB, needsConfirm } from './prefs';
import { askPersistOnce, getBlockStore, getCacheLimitMB } from './cache/instance';
import { fileCacheKey } from './cache/store';

const app = document.getElementById('app')!;
const store = new StateStore();
let config: Config = loadConfig();
let drive: DriveClient | null = null;
let viewer: Viewer | null = null;
let shelf: Shelf | null = null;
/** リンク（?fileId=）で来たとき、ログイン後に開く本 */
let pendingFileId: string | null = fileIdFromLocation(location.search);

function clearFileIdParam(): void {
  const u = new URL(location.href);
  u.searchParams.delete('fileId');
  history.replaceState(null, '', u);
}

function showScreen(el: HTMLElement): void {
  app.replaceChildren(el);
}

// ---------- ログイン / 設定 ----------
function loginScreen(error = ''): void {
  const el = document.createElement('div');
  el.className = 'login';
  el.innerHTML = `
    <h1>書庫</h1>
    <p>Google Drive の書籍・雑誌 PDF を読むビューアです。</p>
    <div class="err"></div>
    <label>OAuth クライアント ID<input class="in-client" placeholder="xxxx.apps.googleusercontent.com" /></label>
    <label>本棚のフォルダ（URL または ID。空ならマイドライブ）<input class="in-folder" placeholder="https://drive.google.com/drive/folders/..." /></label>
    <button class="primary" data-act="login">Google でログイン</button>
    <label class="s-btn alt">ログインせずにPDFを開く<input class="in-file" type="file" accept="application/pdf" hidden /></label>
    <p class="hint">クライアント ID の作り方は docs/google-cloud-setup.md を参照してください。</p>`;
  (el.querySelector('.err') as HTMLElement).textContent = error || (pendingFileId ? 'ログインすると、リンクのPDFを開きます' : '');
  const client = el.querySelector('.in-client') as HTMLInputElement;
  const folder = el.querySelector('.in-folder') as HTMLInputElement;
  client.value = config.clientId;
  folder.value = config.folderId;
  el.querySelector('[data-act=login]')!.addEventListener('click', async () => {
    config = { clientId: client.value.trim(), folderId: parseFolderId(folder.value) };
    if (!config.clientId) { loginScreen('クライアント ID を入力してください'); return; }
    saveConfig(config);
    await signIn(true);
  });
  (el.querySelector('.in-file') as HTMLInputElement).addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void openLocalFile(f);
  });
  showScreen(el);
}

async function signIn(interactive: boolean): Promise<void> {
  try {
    await getToken(config.clientId, interactive);
  } catch (e) {
    loginScreen(e instanceof Error ? e.message : String(e));
    return;
  }
  drive = new DriveClient(config.clientId);
  void store.attach(drive).then(() => shelf && refreshShelf());
  if (pendingFileId) {
    const id = pendingFileId;
    pendingFileId = null;
    clearFileIdParam();
    await openDriveBookById(id);
    return;
  }
  openShelf();
}

function refreshShelf(): void {
  if (shelf && !viewer) openShelf();
}

function openShelf(): void {
  if (!drive) { loginScreen(); return; }
  shelf = new Shelf({
    drive,
    rootFolderId: config.folderId,
    states: () => store.all(),
    onOpen: (item) => void openDriveBook(item),
    onOpenLocal: (f) => void openLocalFile(f),
    onOpenFileId: (id) => void openDriveBookById(id),
    onSettings: () => loginScreen(),
    onSignOut: () => { signOut(); drive = null; shelf = null; loginScreen(); },
  });
  showScreen(shelf.el);
}

// ---------- 本を開く ----------
function startViewer(doc: PDFDoc, key: string, title: string): Viewer {
  viewer?.dispose();
  const v = new Viewer({
    doc,
    title,
    state: store.get(key) ?? defaultBookState(),
    onState: (s) => store.set(key, s),
    onClose: () => {
      viewer?.dispose();
      viewer = null;
      void store.flush();
      if (drive) openShelf(); else loginScreen();
    },
  });
  viewer = v;
  showScreen(v.el);
  return v;
}

function loadingScreen(text: string): void {
  const el = document.createElement('div');
  el.className = 'loading';
  el.textContent = text;
  showScreen(el);
}

const fmtMB = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

/** 取得状況の表示文（取得量・回数。Range が使えず全体を取る場合は割合も） */
function progressText(p: LoadProgress): string {
  if (p.fullDownload && p.total) {
    return `ダウンロード中: ${fmtMB(p.bytes)} / ${fmtMB(p.total)}（${Math.min(100, Math.floor((p.bytes / p.total) * 100))}%）`;
  }
  const saved = p.cachedBytes > 0 ? `・保存済みデータ ${fmtMB(p.cachedBytes)} を使用` : '';
  return `取得済み ${fmtMB(p.bytes)}（${p.requests} 回の通信）${saved}`;
}

/** 進捗つきの読み込み画面。update に取得状況を渡すと表示が変わる */
function progressScreen(title: string, onCancel: () => void): { update: (p: LoadProgress) => void; stop: () => void } {
  const el = document.createElement('div');
  el.className = 'loading progress';
  el.innerHTML = `
    <div class="pg-title"></div>
    <div class="pg-bar"><i></i></div>
    <div class="pg-detail">Drive に接続しています…</div>
    <div class="pg-hint">大きなファイルは、最初のページが出るまで時間がかかることがあります</div>
    <button class="s-btn" data-act="cancel">キャンセル</button>`;
  (el.querySelector('.pg-title') as HTMLElement).textContent = title;
  const bar = el.querySelector('.pg-bar') as HTMLElement;
  const fill = bar.querySelector('i') as HTMLElement;
  const detail = el.querySelector('.pg-detail') as HTMLElement;
  const startedAt = Date.now();
  let last = '';
  const render = () => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    detail.textContent = `${last || 'Drive に接続しています…'}・${sec} 秒`;
  };
  const tick = window.setInterval(render, 500);
  el.querySelector('[data-act=cancel]')!.addEventListener('click', () => { window.clearInterval(tick); onCancel(); });
  showScreen(el);
  return {
    update: (p) => {
      last = progressText(p);
      if (p.fullDownload && p.total) {
        bar.classList.remove('indeterminate');
        fill.style.width = `${Math.min(100, (p.bytes / p.total) * 100)}%`;
      } else {
        bar.classList.add('indeterminate'); // 全体の量が分からないので、動いていることだけ示す
      }
      render();
    },
    stop: () => window.clearInterval(tick),
  };
}

async function openDriveBook(item: DriveItem): Promise<void> {
  if (!drive) return;
  // 保存領域: 一度開いたデータが残っていれば、通信せずに読める（上限 0 のときは使わない）
  const limitMB = getCacheLimitMB();
  const store = limitMB > 0 ? await getBlockStore() : null;
  const cacheKey = fileCacheKey(item.id, item.modifiedTime ?? item.size);
  const alreadySaved = store ? await store.cachedBytes(cacheKey) : 0;
  // 大きなファイルは、通信量と時間がかかるので、開く前に確認する（設定でしきい値を変えられる）。
  // すでに十分な量を保存済みなら、通信はわずかで済むので確認しない
  const mostlySaved = !!item.size && alreadySaved >= Math.min(item.size, 16e6);
  if (!mostlySaved && needsConfirm(item.size, getConfirmMB()) && !(await confirmLargeOpen(item.name.replace(/\.pdf$/i, ''), item.size!))) {
    if (app.firstElementChild !== shelf?.el) openShelf(); // リンクから来た場合などは、本棚に戻す
    return;
  }
  const openedAt = Date.now();
  let fetched = 0;
  const ac = new AbortController();
  const screen = progressScreen(`「${item.name}」を開いています`, () => {
    ac.abort();
    openShelf();
  });
  const bar = screen.update;
  bar({ bytes: 0, requests: 0, total: item.size, fullDownload: false, cachedBytes: 0 });
  // 開いたあと、最初のページを描画している間も取得状況を表示するための受け口
  let sink: (p: LoadProgress) => void = (p) => { fetched = p.bytes; bar(p); };
  try {
    const doc = await openDrive(drive, item.id, item.size, {
      signal: ac.signal,
      onProgress: (p) => sink(p),
      cache: store ? { store, key: cacheKey, fileId: item.id, name: item.name } : undefined,
    });
    screen.stop();
    if (ac.signal.aborted) { void doc.destroy(); return; }
    const v = startViewer(doc, item.id, item.name.replace(/\.pdf$/i, ''));
    sink = (p) => { fetched = p.bytes; v.setStatus(`最初のページを描画しています…（${progressText(p)}）`); };
    void v.ready.then(() => {
      sink = () => {};
      // 次回の確認画面で「開くまでの時間の目安」に使う
      if (item.size && fetched > 0) addHistory({ size: item.size, ms: Date.now() - openedAt, bytes: fetched });
      // 保存領域の後始末: 更新前の古い版を消し、上限を超えたら使っていない本から消す
      if (store) {
        askPersistOnce();
        void store.touch(cacheKey);
        void store.removeOtherVersions(item.id, cacheKey).then(() => store.trim(limitMB * 1e6, cacheKey)).catch(() => {});
      }
    });
  } catch (e) {
    screen.stop();
    if (ac.signal.aborted) return;
    alert(`開けませんでした: ${e instanceof Error ? e.message : e}`);
    openShelf();
  }
}

async function openDriveBookById(fileId: string): Promise<void> {
  if (!drive) return;
  loadingScreen('ファイルを確認しています…');
  try {
    const item = await drive.getMeta(fileId);
    if (item.mimeType !== 'application/pdf') throw new Error('PDFファイルではありません');
    await openDriveBook(item);
  } catch (e) {
    alert(`開けませんでした: ${e instanceof Error ? e.message : e}`);
    openShelf();
  }
}

async function openLocalFile(file: File): Promise<void> {
  loadingScreen(`「${file.name}」を開いています…`);
  try {
    const doc = await openLocal(file);
    // ローカルファイルは名前+サイズで識別する（Drive の本とは混ざらない）
    startViewer(doc, `local:${file.name}:${file.size}`, file.name.replace(/\.pdf$/i, ''));
  } catch (e) {
    alert(`開けませんでした: ${e instanceof Error ? e.message : e}`);
    if (drive) openShelf(); else loginScreen();
  }
}

// ---------- 起動 ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 未対応環境では無視 */ });
}

if (config.clientId && hasSignedInBefore()) void signIn(false);
else loginScreen();
