import { isIOS } from '../viewer/layout';
import { BlockStore } from './store';

let opened: Promise<BlockStore | null> | null = null;

/** アプリ全体で共有する保存領域。使えない環境では null */
export function getBlockStore(): Promise<BlockStore | null> {
  opened ??= BlockStore.open();
  return opened;
}

const KEY_LIMIT = 'dpr:cacheLimitMB';

/** 保存データの上限（MB）の選択肢。0 は保存しない */
export const CACHE_LIMIT_CHOICES = [0, 300, 1000, 2000, 5000];

/** 既定の上限。iOS は保存領域が小さく、使っていないと消されることもあるので控えめにする */
export function defaultCacheLimitMB(): number {
  return isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) ? 300 : 2000;
}

export function getCacheLimitMB(): number {
  try {
    const raw = localStorage.getItem(KEY_LIMIT);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  } catch { /* ignore */ }
  return defaultCacheLimitMB();
}

export function setCacheLimitMB(mb: number): void {
  try { localStorage.setItem(KEY_LIMIT, String(mb)); } catch { /* ignore */ }
}

let persistAsked = false;
/** 保存したデータを、ブラウザの判断で勝手に消されにくくするよう頼む（許可されるかはブラウザ次第） */
export function askPersistOnce(): void {
  if (persistAsked) return;
  persistAsked = true;
  try { void navigator.storage?.persist?.(); } catch { /* ignore */ }
}
