import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { DriveClient } from '../drive/api';

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

const INITIAL_CHUNK = 1024 * 1024;
/**
 * 1回の取得の最小単位（PDF.js の既定と同じ）。大きくすると往復は減るが、ページ情報が散らばった PDF では
 * 開いた直後にほぼ全体を取得してしまう（試験用の 99MB / 120 ページで、1MB 単位だと 100MB、64KB だと 9MB）。
 * 画像など連続した大きなデータは、単位に関係なく 1 回の範囲指定にまとめて取得される。
 */
const RANGE_CHUNK = 65536;

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

const RETRIES = 2;

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

  emit(true);
  if (!size) return downloadAll();

  prog.requests++;
  const initial = await drive.fetchRange(fileId, 0, Math.min(size, INITIAL_CHUNK), o.signal);
  if (!initial) return downloadAll();
  prog.bytes += initial.length;
  emit(true);

  let fail: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => { fail = reject; });

  class DriveTransport extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number): void {
      void this.fetchWithRetry(begin, Math.min(end, size!));
    }
    private async fetchWithRetry(begin: number, end: number): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        if (o.signal?.aborted) return;
        try {
          prog.requests++;
          const chunk = await drive.fetchRange(fileId, begin, end, o.signal);
          if (!chunk) throw new Error('Drive が範囲指定の取得に応じませんでした');
          prog.bytes += chunk.length;
          emit();
          this.onDataRange(begin, chunk);
          return;
        } catch (e) {
          if (o.signal?.aborted) return;
          if (attempt >= RETRIES) { fail(e instanceof Error ? e : new Error(String(e))); return; }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
  }
  const task = pdfjs.getDocument({
    range: new DriveTransport(size, initial),
    ...DOC_OPTS,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: RANGE_CHUNK,
  });
  o.signal?.addEventListener('abort', () => { void task.destroy(); });
  try {
    return await Promise.race([task.promise, failed]);
  } catch (e) {
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
