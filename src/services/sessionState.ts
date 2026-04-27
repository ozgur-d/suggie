import * as vscode from 'vscode';
import { EditEntry, FileSwitchEntry, FeedbackEntry, FeedbackAction } from '../models/types';

export class SessionState implements vscode.Disposable {
  private editHistory: EditEntry[] = [];
  private fileSwitchHistory: FileSwitchEntry[] = [];
  private feedbackHistory: FeedbackEntry[] = [];
  private editVelocity = 0;
  private keystrokeTimestamps: number[] = [];
  private disposables: vscode.Disposable[] = [];

  private static readonly MAX_SWITCH_ENTRIES = 20;
  private static readonly MAX_FEEDBACK_ENTRIES = 50;
  private static readonly VELOCITY_WINDOW_MS = 5000;

  constructor() {
    // Wired in US3 (T019)
  }

  startTracking(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;
        const now = Date.now();

        this.keystrokeTimestamps.push(now);
        this.keystrokeTimestamps = this.keystrokeTimestamps.filter(
          (t) => now - t < SessionState.VELOCITY_WINDOW_MS
        );
        this.editVelocity =
          this.keystrokeTimestamps.length / (SessionState.VELOCITY_WINDOW_MS / 1000);

        for (const change of e.contentChanges) {
          this.editHistory.push({
            uri: e.document.uri.fsPath,
            timestamp: now,
            startLine: change.range.start.line,
            endLine: change.range.end.line,
            text: change.text,
            rangeLength: change.rangeLength,
          });
        }

        this.evictOldEdits();
      })
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const toUri = editor.document.uri.fsPath;
        const last =
          this.fileSwitchHistory.length > 0
            ? this.fileSwitchHistory[this.fileSwitchHistory.length - 1]
            : null;
        const fromUri = last?.toUri ?? null;

        if (fromUri === toUri) return;

        this.fileSwitchHistory.push({
          fromUri,
          toUri,
          timestamp: Date.now(),
        });

        if (this.fileSwitchHistory.length > SessionState.MAX_SWITCH_ENTRIES) {
          this.fileSwitchHistory.shift();
        }
      })
    );
  }

  getAdaptiveWindowMs(): number {
    const minWindow = 60_000;
    const maxWindow = 300_000;
    const highVelocity = 3;
    const lowVelocity = 0.5;

    if (this.editVelocity >= highVelocity) return minWindow;
    if (this.editVelocity <= lowVelocity) return maxWindow;

    const ratio =
      (this.editVelocity - lowVelocity) / (highVelocity - lowVelocity);
    return maxWindow - ratio * (maxWindow - minWindow);
  }

  getRecentEdits(): EditEntry[] {
    const cutoff = Date.now() - this.getAdaptiveWindowMs();
    return this.editHistory.filter((e) => e.timestamp >= cutoff);
  }

  getFileSwitchHistory(): FileSwitchEntry[] {
    return [...this.fileSwitchHistory];
  }

  getRecentFeedback(): FeedbackEntry[] {
    return [...this.feedbackHistory];
  }

  recordFeedback(
    requestId: string,
    action: FeedbackAction,
    insertedText: string
  ): void {
    this.feedbackHistory.push({
      requestId,
      action,
      insertedText,
      timestamp: Date.now(),
    });

    if (this.feedbackHistory.length > SessionState.MAX_FEEDBACK_ENTRIES) {
      this.feedbackHistory.shift();
    }
  }

  private evictOldEdits(): void {
    const cutoff = Date.now() - 300_000; // 5 minutes max
    this.editHistory = this.editHistory.filter((e) => e.timestamp >= cutoff);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
