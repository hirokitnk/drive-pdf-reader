import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { DriveClient } from '../drive/api';
import { BlockLoader } from './blocks';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = new URL('./pdfjs/', document.baseURI).href;
const DOC_OPTS = {
  cMapUrl: `${assetBase}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assetBase}standard_fonts/`,
};

export type PDFDoc = pdfjs.PDFDocumentProxy;

/** ローカルのファイル（開発用/Driveを使わない場合） */
export async function openLocal(file: File): Promise<PDFDoc> {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data, ...DOC_OPTS }).promise;
}

/**
 * PDF.js が読み込みを依頼する最小単位。ブロック取得で大きな単位にまとめるので、既定のままでよい。
 */
const RANGE_CHUNK = 65536;
/**
 * Drive の範囲取得は、サイズに関係なく 1 回ごとに約 2.5 秒の待ちがある（実機で計測。4MB でも受信は 0.2 秒）。
 * そのため 1 回で大きく取る。4MB は、帯域が細い回線でも 1 回 1〜2 秒に収まる大きさ。
 */
const BLOCK_SIZE = 4 * 1024 * 1024;
/** 同時に取得する数（実機の計測では 4 本同時でも 1 本と同じ時間で完了した） */
const CONCURRENCY = 6;
/** 要求された位置の先を、何ブロック（= 32MB）まで先読みするか */
const READ_AHEAD = 8;
/** 先読みしたブロックを置いておく上限（40 ブロック = 160MB）。PDF.js 側にも同じデータが載るため、無制限にはしない */
const MAX_CACHED_BLOCKS = 40;

/** 開いている間の取得状況（進捗表示用） */
export interface LoadProgress {
  /** 取得済みのバイト数 */
  bytes: number;
  /** リクエストの回数 */
  requests: number;
  /** ファイル全体のサイズ（分かれば） */
  total?: number;
  /** ファイル全体をダウンロードしている（Range が使えない場合） */
  fullDownload: boolean;
}

export interface OpenOptions {
  signal?: AbortSignal;
  /** 開いたあと（最初のページの描画中など）も、取得のたびに呼ばれる */
  onProgress?: (p: LoadProgress) => void;
}

/**
 * Drive上のPDFを Range 取得で開く。必要な部分だけを取りにいくので、数百MBでも先頭から表示できる。
 * サーバーが Range を返さない場合は全体をダウンロードして開く。
 */
export async function openDrive(
  drive: DriveClient, fileId: string, size: number | undefined, o: OpenOptions = {},
): Promise<PDFDoc> {
  const prog: LoadProgress = { bytes: 0, requests: 0, total: size, fullDownload: false };
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastEmit < 100) return; // 画面の更新は 1 秒に 10 回まで
    lastEmit = now;
    o.onProgress?.({ ...prog });
  };
  const downloadAll = async (): Promise<PDFDoc> => {
    prog.fullDownload = true;
    prog.bytes = 0;
    const data = await drive.fetchAll(fileId, {
      signal: o.signal,
      onProgress: (n) => { prog.bytes = n; emit(); },
    });
    emit(true);
    return pdfjs.getDocument({ data, ...DOC_OPTS }).promise;
  };
  const fetchBlock = async (begin: number, end: number): Promise<Uint8Array> => {
    prog.requests++;
    const chunk = await drive.fetchRange(fileId, begin, end, o.signal);
    if (!chunk) throw new Error('Drive が範囲指定の取得に応じませんでした');
    prog.bytes += chunk.length;
    emit();
    return chunk;
  };

  emit(true);
  if (!size) return downloadAll();

  // 先頭（初期データ）と末尾（構造情報があることが多い）を同時に取る。順番に取ると待ちが 2 倍になる
  const lastBlock = Math.max(0, Math.ceil(size / BLOCK_SIZE) - 1);
  const [head, tail] = await Promise.all([
    fetchBlock(0, Math.min(size, BLOCK_SIZE)).catch(() => null),
    lastBlock > 0 ? fetchBlock(lastBlock * BLOCK_SIZE, size).catch(() => null) : Promise.resolve(null),
  ]);
  if (!head) return downloadAll();

  let fail: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => { fail = reject; });
  let transport!: pdfjs.PDFDataRangeTransport;
  const loader = new BlockLoader({
    size,
    blockSize: BLOCK_SIZE,
    concurrency: CONCURRENCY,
    readAhead: READ_AHEAD,
    maxCachedBlocks: MAX_CACHED_BLOCKS,
    fetchBlock,
    deliver: (begin, chunk) => transport.onDataRange(begin, chunk),
    onError: (e) => fail(e),
  });
  class DriveTransport extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number): void {
      loader.demand(begin, Math.min(end, size!));
    }
  }
  transport = new DriveTransport(size, head);
  loader.hold(0); // 先頭ブロックは PDF.js に初期データとして渡してある
  if (tail) loader.provide(lastBlock, tail);

  const task = pdfjs.getDocument({
    range: transport,
    ...DOC_OPTS,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: RANGE_CHUNK,
  });
  const stop = () => loader.stop();
  o.signal?.addEventListener('abort', () => { stop(); void task.destroy(); });
  try {
    const doc = await Promise.race([task.promise, failed]);
    // 文書を閉じたら、先読みも止める
    const destroy = doc.destroy.bind(doc);
    doc.destroy = () => { stop(); return destroy(); };
    return doc;
  } catch (e) {
    stop();
    void task.destroy();
    throw e;
  }
}

/** PDFのメタデータ（ViewerPreferences の Direction）から綴じ方向を推定する */
export async function detectDirection(doc: PDFDoc): Promise<'rtl' | 'ltr' | undefined> {
  try {
    const prefs = (await doc.getViewerPreferences()) as { Direction?: string } | null;
    if (prefs?.Direction === 'R2L') return 'rtl';
    if (prefs?.Direction === 'L2R') return 'ltr';
  } catch { /* ignore */ }
  return undefined;
}
