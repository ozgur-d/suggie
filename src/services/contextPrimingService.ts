import * as vscode from 'vscode';
import { CliService } from './cliService';
import { ModelTier } from '../models/types';

interface PrimedFile {
  uri: string;
  version: number;
  lineCount: number;
  primedAt: number;
}

interface QueueEntry {
  type: 'prime' | 'completion';
  execute: () => Promise<void>;
}

export class ContextPrimingService implements vscode.Disposable {
  private primedFiles = new Map<string, PrimedFile>();
  private disposables: vscode.Disposable[] = [];
  private queue: QueueEntry[] = [];
  private processing = false;
  private log: vscode.OutputChannel | null = null;

  constructor(
    private cliService: CliService,
    private getModel: () => ModelTier,
    private getExcludePatterns: () => string[]
  ) {}

  setOutputChannel(channel: vscode.OutputChannel): void {
    this.log = channel;
  }

  private logInfo(msg: string): void {
    this.log?.appendLine(`[${new Date().toISOString()}] [Priming] ${msg}`);
  }

  startTracking(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || editor.document.uri.scheme !== 'file') return;
        this.schedulePrime(editor.document);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;
        if (e.contentChanges.length === 0) return;
        const primed = this.primedFiles.get(e.document.uri.toString());
        if (!primed) return;

        const versionDrift = e.document.version - primed.version;
        if (versionDrift > 10) {
          this.schedulePrime(e.document);
        } else {
          this.scheduleUpdate(e.document, e.contentChanges);
        }
      })
    );

    // Prime the currently active file immediately
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      this.schedulePrime(activeEditor.document);
    }
  }

  isFilePrimed(uri: string): boolean {
    return this.primedFiles.has(uri);
  }

  getPrimedFile(uri: string): PrimedFile | undefined {
    return this.primedFiles.get(uri);
  }

  private isExcluded(filePath: string): boolean {
    const patterns = this.getExcludePatterns();
    const fileName = filePath.split(/[/\\]/).pop() ?? '';
    return patterns.some((pattern) => {
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      return regex.test(fileName);
    });
  }

  private schedulePrime(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    if (this.isExcluded(document.uri.fsPath)) return;
    if (document.lineCount > 2000) {
      this.logInfo(`Skipping prime for ${document.uri.fsPath} (${document.lineCount} lines, too large)`);
      return;
    }

    // Remove any pending prime for the same file
    this.queue = this.queue.filter(
      (e) => !(e.type === 'prime' && (e as unknown as { uri: string }).uri === uri)
    );

    const entry: QueueEntry & { uri: string } = {
      type: 'prime',
      uri,
      execute: async () => {
        const content = document.getText();
        const relativePath = vscode.workspace.asRelativePath(document.uri);
        const prompt = `[CONTEXT PRIME] file: ${relativePath} (${document.languageId}, ${document.lineCount} lines, v${document.version})\n\`\`\`\n${content}\n\`\`\`\nRespond with only: OK`;

        this.logInfo(`Priming: ${relativePath} (${document.lineCount} lines, ~${Math.ceil(content.length / 4)} tokens)`);
        const startTime = Date.now();

        await this.cliService.spawnCompletion(prompt, this.getModel());

        this.primedFiles.set(uri, {
          uri: document.uri.fsPath,
          version: document.version,
          lineCount: document.lineCount,
          primedAt: Date.now(),
        });

        this.logInfo(`Primed: ${relativePath} in ${Date.now() - startTime}ms`);
      },
    };

    this.queue.push(entry);
    this.processQueue();
  }

  private scheduleUpdate(
    document: vscode.TextDocument,
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): void {
    const uri = document.uri.toString();
    const relativePath = vscode.workspace.asRelativePath(document.uri);

    const changeSummary = changes.map((c) => {
      const startLine = c.range.start.line;
      const endLine = c.range.end.line;
      const snippet = c.text.slice(0, 200).replace(/\n/g, '\\n');
      return `L${startLine}-L${endLine}: "${snippet}"`;
    }).join('\n');

    const entry: QueueEntry = {
      type: 'prime',
      execute: async () => {
        const prompt = `[CONTEXT UPDATE] file: ${relativePath} (v${document.version})\nChanges:\n${changeSummary}\nRespond with only: OK`;

        this.logInfo(`Update: ${relativePath} (${changes.length} changes)`);
        await this.cliService.spawnCompletion(prompt, this.getModel());

        const primed = this.primedFiles.get(uri);
        if (primed) {
          primed.version = document.version;
          primed.primedAt = Date.now();
        }
      },
    };

    this.queue.push(entry);
    this.processQueue();
  }

  async executeCompletion<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Completions go to front of queue, ahead of all primes
      const entry: QueueEntry = {
        type: 'completion',
        execute: async () => {
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          }
        },
      };

      // Insert before first prime entry (after any other completions)
      const firstPrimeIndex = this.queue.findIndex((e) => e.type === 'prime');
      if (firstPrimeIndex === -1) {
        this.queue.push(entry);
      } else {
        this.queue.splice(firstPrimeIndex, 0, entry);
      }

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        await entry.execute();
      } catch (e) {
        this.logInfo(`Queue entry failed: ${e}`);
      }
    }

    this.processing = false;
  }

  resetOnProcessRestart(): void {
    this.primedFiles.clear();
    this.logInfo('Cleared all primed files (process restart)');
    // Re-prime active file
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      this.schedulePrime(activeEditor.document);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.primedFiles.clear();
    this.queue = [];
  }
}
