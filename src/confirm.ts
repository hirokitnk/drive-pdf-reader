import { CONFIRM_CHOICES, estimateOpenSeconds, expectedFirstPageBytes, loadHistory, setConfirmMB } from './prefs';

const fmtMB = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

/** 開く前の確認文（テストしやすいよう、画面とは分けて作る） */
export function confirmLines(name: string, size: number, historySeconds: number | null): string[] {
  const lines = [
    `ファイルサイズ: ${fmtMB(size)}`,
    `最初のページまでの通信量の目安: 約 ${fmtMB(expectedFirstPageBytes(size))}（読み進めると、最大で ${fmtMB(size)}）`,
  ];
  lines.push(historySeconds === null
    ? '開くまでの時間: 回線によって数秒〜1 分以上かかります（初めてなので目安がありません）'
    : `開くまでの時間: これまで大きいファイルは、中央値で約 ${historySeconds} 秒でした（回線によって変わります）`);
  void name;
  return lines;
}

/** 大きなファイルを開く前の確認。続けるなら true */
export function confirmLargeOpen(name: string, size: number): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="modal-box">
        <div class="modal-title">大きなファイルを開きますか？</div>
        <div class="modal-name"></div>
        <ul class="modal-lines"></ul>
        <label class="modal-skip"><input type="checkbox" /> 次回から確認しない</label>
        <div class="modal-actions">
          <button class="s-btn" data-act="no">やめる</button>
          <button class="primary" data-act="yes">開く</button>
        </div>
      </div>`;
    (el.querySelector('.modal-name') as HTMLElement).textContent = name;
    const ul = el.querySelector('.modal-lines') as HTMLElement;
    for (const line of confirmLines(name, size, estimateOpenSeconds(loadHistory()))) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.append(li);
    }
    const skip = el.querySelector('input') as HTMLInputElement;
    const done = (ok: boolean) => {
      window.removeEventListener('keydown', onKey, true); // 登録時と同じく capture を指定しないと外れない
      if (ok && skip.checked) setConfirmMB(0);
      el.remove();
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    };
    window.addEventListener('keydown', onKey, true);
    el.querySelector('[data-act=no]')!.addEventListener('click', () => done(false));
    el.querySelector('[data-act=yes]')!.addEventListener('click', () => done(true));
    document.body.append(el);
    (el.querySelector('[data-act=yes]') as HTMLElement).focus();
  });
}

export { CONFIRM_CHOICES };
