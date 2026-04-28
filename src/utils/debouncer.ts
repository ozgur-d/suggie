import { Disposable } from 'vscode';

export class Debouncer implements Disposable {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: (() => void) | null = null;
  private getDelayMs: () => number;

  constructor(getDelayMs: () => number) {
    this.getDelayMs = getDelayMs;
  }

  trigger<T>(callback: () => Promise<T>): Promise<T | null> {
    this.cancel();
    return new Promise<T | null>((resolve) => {
      this.pendingResolve = () => resolve(null);
      this.timer = setTimeout(async () => {
        this.timer = null;
        this.pendingResolve = null;
        try {
          const result = await callback();
          resolve(result);
        } catch {
          resolve(null);
        }
      }, this.getDelayMs());
    });
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  dispose(): void {
    this.cancel();
  }
}
