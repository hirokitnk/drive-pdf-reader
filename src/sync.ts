import type { DriveClient } from './drive/api';
import { loadLocalStates, mergeStates, saveLocalStates, type BookState, type BookStates } from './store/progress';

/** 読書位置の保存と同期。まず localStorage に保存し、ログイン中は Drive の appDataFolder にも反映する */
export class StateStore {
  private states: BookStates = loadLocalStates();
  private timer = 0;
  private drive: DriveClient | null = null;

  all(): BookStates { return this.states; }
  get(id: string): BookState | undefined { return this.states[id]; }

  set(id: string, s: BookState): void {
    this.states = { ...this.states, [id]: s };
    saveLocalStates(this.states);
    this.scheduleUpload();
  }

  /** ログイン後に呼ぶ。リモートの状態を取り込んで、新しい方を採用する */
  async attach(drive: DriveClient): Promise<void> {
    this.drive = drive;
    try {
      const remote = await drive.loadRemoteStates();
      this.states = mergeStates(this.states, remote);
      saveLocalStates(this.states);
      this.scheduleUpload();
    } catch (e) {
      console.warn('読書位置の同期に失敗しました（端末内の記録は有効です）', e);
    }
  }

  private scheduleUpload(): void {
    if (!this.drive) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 2000);
  }

  async flush(): Promise<void> {
    if (!this.drive) return;
    window.clearTimeout(this.timer);
    try {
      this.states = await this.drive.pushStates(this.states);
      saveLocalStates(this.states);
    } catch (e) {
      console.warn('読書位置の同期に失敗しました', e);
    }
  }
}
