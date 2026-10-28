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
 * Drive上のPDFを Range 取得で開く。必要な部分だけを取りにいくので、数百MBでも先頭から表示できる。
 * サーバーが Range を返さない場合は全体をダウンロードして開く。
 */
export async function openDrive(drive: DriveClient, fileId: string, size: number | undefined): Promise<PDFDoc> {
  if (!size) return pdfjs.getDocument({ data: await drive.fetchAll(fileId), ...DOC_OPTS }).promise;

  const initial = await drive.fetchRange(fileId, 0, Math.min(size, INITIAL_CHUNK));
  if (!initial) return pdfjs.getDocument({ data: await drive.fetchAll(fileId), ...DOC_OPTS }).promise;

  class DriveTransport extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number): void {
      drive
        .fetchRange(fileId, begin, Math.min(end, size!))
        .then((chunk) => {
          if (chunk) this.onDataRange(begin, chunk);
        })
        .catch((e) => console.error('range fetch failed', e));
    }
  }
  const transport = new DriveTransport(size, initial);
  return pdfjs.getDocument({ range: transport, ...DOC_OPTS, disableAutoFetch: true, disableStream: true }).promise;
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
