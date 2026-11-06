// 通信診断: Drive との通信が何に時間を使っているかを、実機で測って表示する

import type { DriveClient, DriveItem } from './drive/api';

const API = 'https://www.googleapis.com/drive/v3';
const DOWNLOAD = 'https://www.googleapis.com/download/drive/v3';

interface Sample { label: string; ms: number; ttfb?: number; bytes?: number; note?: string }

const fmt = (n: number) => `${Math.round(n)} ms`;
const mbps = (bytes: number, ms: number) => `${((bytes / 1e6) / (ms / 1000)).toFixed(2)} MB/s`;

async function timed(label: string, run: () => Promise<{ bytes: number; ttfb: number }>): Promise<Sample> {
  const t0 = performance.now();
  try {
    const r = await run();
    return { label, ms: performance.now() - t0, ttfb: r.ttfb, bytes: r.bytes };
  } catch (e) {
    return { label, ms: performance.now() - t0, note: `失敗: ${e instanceof Error ? e.message : e}` };
  }
}

/** Range 取得を 1 回行う。ダウンロード専用のパス（/download/）を使うかを選べる */
async function range(token: string, id: string, begin: number, len: number, downloadPath: boolean) {
  const t0 = performance.now();
  const url = `${downloadPath ? DOWNLOAD : API}/files/${id}?alt=media&supportsAllDrives=true`;
  const headers: Record<string, string> = { Range: `bytes=${begin}-${begin + len - 1}`, Authorization: `Bearer ${token}` };
  const res = await fetch(url, { headers });
  const ttfb = performance.now() - t0;
  if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return { bytes: buf.byteLength, ttfb };
}

export async function runDiagnostics(drive: DriveClient, item: DriveItem, log: (text: string) => void): Promise<void> {
  const size = item.size ?? 0;
  const out: string[] = [];
  const emit = (line = '') => { out.push(line); log(out.join('\n')); };
  emit(`ファイル: ${item.name}`);
  emit(`サイズ: ${(size / 1e6).toFixed(1)} MB`);
  emit(`通信環境: ${(navigator as Navigator & { connection?: { effectiveType?: string; rtt?: number; downlink?: number } }).connection
    ? JSON.stringify((navigator as Navigator & { connection?: object }).connection) : '情報なし'}`);
  emit();
  if (size < 20e6) { emit('※ サイズが小さいため、測定位置が重なります（20MB 以上のファイル推奨）'); emit(); }

  const token = await drive.accessToken();
  // キャッシュの影響を避けるため、毎回ちがう位置を読む
  const pos = (i: number) => Math.floor((size * (0.08 + 0.11 * i)) / 65536) * 65536;
  const show = (s: Sample) => emit(
    `${s.label.padEnd(26, ' ')} ${fmt(s.ms).padStart(8)}` +
    (s.ttfb !== undefined ? `  (応答まで ${fmt(s.ttfb)} / 受信 ${fmt(s.ms - s.ttfb)}${s.bytes ? ' / ' + mbps(s.bytes, s.ms) : ''})` : '') +
    (s.note ? `  ${s.note}` : ''));

  emit('■ 1. メタデータ取得（小さい JSON）x3');
  for (let i = 0; i < 3; i++) {
    show(await timed(`メタデータ #${i + 1}`, async () => {
      const t0 = performance.now();
      const res = await fetch(`${API}/files/${item.id}?fields=id&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
      const ttfb = performance.now() - t0;
      const b = (await res.arrayBuffer()).byteLength;
      return { bytes: b, ttfb };
    }));
  }
  emit();
  emit('■ 2. Range 64KB を順番に x4（トークンはヘッダ）');
  for (let i = 0; i < 4; i++) show(await timed(`64KB #${i + 1}`, () => range(token, item.id, pos(i), 65536, false)));
  emit();
  emit('■ 3. Range 64KB を順番に x4（ダウンロード専用の URL）');
  for (let i = 0; i < 4; i++) show(await timed(`64KB(/download/) #${i + 1}`, () => range(token, item.id, pos(i + 4), 65536, true)));
  emit();
  emit('■ 4. Range 4MB を 1 回（帯域の目安）');
  show(await timed('4MB', () => range(token, item.id, pos(1), 4 * 1024 * 1024, false)));
  emit();
  emit('■ 5. Range 4MB を 4 本同時（アプリの実際の取得方法に近い）');
  const t0 = performance.now();
  const par = await Promise.all([0, 1, 2, 3].map((i) =>
    timed(`4MB 並列 #${i + 1}`, () => range(token, item.id, pos(i + 2), 4 * 1024 * 1024, false))));
  par.forEach(show);
  emit(`  → 4 本の合計所要: ${fmt(performance.now() - t0)}`);
  emit();
  emit('測定が終わりました。この画面のスクリーンショットを送ってください。');
}
