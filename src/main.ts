import './style.css';
import { fileIdFromLocation, loadConfig, parseFolderId, saveConfig, type Config } from './config';
import { getToken, hasSignedInBefore, signOut } from './drive/auth';
import { DriveClient, type DriveItem } from './drive/api';
import { Shelf } from './shelf/shelf';
import { StateStore } from './sync';
import { Viewer } from './viewer/viewer';
import { openDrive, openLocal, type PDFDoc } from './viewer/source';
import { defaultBookState } from './store/progress';

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
function startViewer(doc: PDFDoc, key: string, title: string): void {
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
}

function loadingScreen(text: string): void {
  const el = document.createElement('div');
  el.className = 'loading';
  el.textContent = text;
  showScreen(el);
}

async function openDriveBook(item: DriveItem): Promise<void> {
  if (!drive) return;
  loadingScreen(`「${item.name}」を開いています…`);
  try {
    const doc = await openDrive(drive, item.id, item.size);
    startViewer(doc, item.id, item.name.replace(/\.pdf$/i, ''));
  } catch (e) {
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
