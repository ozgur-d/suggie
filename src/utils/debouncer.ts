import { Disposable } from 'vscode';

export class Debouncer implements Disposable {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private getDelayMs: () => number;

  constructor(getDelayMs: () => number) {
    this.getDelayMs = getDelayMs;
  }

  trigger<T>(callback: () => Promise<T>): Promise<T | null> {
    this.cancel();
    return new Promise<T | null>((resolve) => {
      this.timer = setTimeout(async () => {
        this.timer = null;
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
  }

  dispose(): void {
    this.cancel();
  }
}
