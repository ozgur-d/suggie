import { spawn, ChildProcess } from 'child_process';
import { CancellationToken, OutputChannel } from 'vscode';
import { ModelTier, MODEL_CONFIGS, FileContext, EditEntry, FileSwitchEntry } from '../models/types';

const SYSTEM_PROMPT = [
  'You are an inline code completion engine. Return ONLY the raw code to insert at the cursor. Rules:',
  '- No explanations, markdown, code fences, or comments about the completion.',
  '- Never repeat code that already exists immediately before or after the cursor.',
  '- Prefer a single expression or statement. Only produce multi-line output when the context clearly requires it (e.g., a function body, object literal, or block).',
  '- Match the surrounding style: indentation, quotes, semicolons, naming conventions.',
  '- If the cursor is mid-token, complete that token first before adding new code.',
  '- Infer intent from context (e.g., test assertion, function argument, import, loop body) and complete accordingly.',
].join('\n');

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function getChangeType(edit: EditEntry): string {
  if (edit.rangeLength === 0) return 'INSERT';
  if (edit.text.length === 0) return 'DELETE';
  return 'REPLACE';
}

export interface CliDetectionResult {
  available: boolean;
  version: string | null;
  path: string;
}

interface PendingRequest {
  resolve: (result: string | null) => void;
  cancelled: boolean;
  startTime: number;
}

export class CliService {
  private persistentProc: ChildProcess | null = null;
  private cliPath: string = 'claude';
  private currentModel: ModelTier | null = null;
  private lastDetection: CliDetectionResult | null = null;
  private log: OutputChannel | null = null;

  private lineBuffer = '';
  private pendingRequest: PendingRequest | null = null;
  private assistantText = '';
  private ready = false;
  private busy = false;

  setOutputChannel(channel: OutputChannel): void {
    this.log = channel;
  }

  private logInfo(msg: string): void {
    this.log?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  setCliPath(path: string): void {
    this.cliPath = path || 'claude';
    this.logInfo(`CLI path set to: ${this.cliPath}`);
  }

  getLastDetection(): CliDetectionResult | null {
    return this.lastDetection;
  }

  async detectCli(): Promise<CliDetectionResult> {
    this.logInfo(`Detecting CLI at: ${this.cliPath}`);
    return new Promise<CliDetectionResult>((resolve) => {
      const proc = spawn(this.cliPath, ['--version'], {
        shell: false,
        timeout: 5000,
      });

      let stdout = '';
      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        const result: CliDetectionResult = {
          available: code === 0,
          version: code === 0 ? stdout.trim() : null,
          path: this.cliPath,
        };
        this.lastDetection = result;
        this.logInfo(`CLI detection: ${result.available ? `found v${result.version}` : `not found (exit ${code})`}`);
        resolve(result);
      });

      proc.on('error', (err) => {
        const result: CliDetectionResult = {
          available: false,
          version: null,
          path: this.cliPath,
        };
        this.lastDetection = result;
        this.logInfo(`CLI detection error: ${err.message}`);
        resolve(result);
      });
    });
  }

  private ensureProcess(model: ModelTier): void {
    if (this.persistentProc && !this.persistentProc.killed && this.currentModel === model) {
      return;
    }

    this.killPersistentProcess();
    this.logInfo(`Spawning persistent CLI process: model=${model}`);

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--no-session-persistence',
      '--tools', '',
      '--system-prompt', SYSTEM_PROMPT,
    ];

    const proc = spawn(this.cliPath, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.persistentProc = proc;
    this.currentModel = model;
    this.lineBuffer = '';
    this.ready = true;
    this.busy = false;

    this.logInfo(`Process spawned: pid=${proc.pid}, stdin=${!!proc.stdin}, stdout=${!!proc.stdout}, stderr=${!!proc.stderr}`);

    proc.stdout?.on('data', (data: Buffer) => {
      this.lineBuffer += data.toString();
      this.processLines();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        this.logInfo(`stderr: ${text.slice(0, 500)}`);
      }
    });

    proc.on('close', (code) => {
      this.logInfo(`Persistent process exited: code=${code}`);
      this.persistentProc = null;
      this.currentModel = null;
      this.ready = false;
      this.busy = false;
      if (this.pendingRequest) {
        this.pendingRequest.resolve(null);
        this.pendingRequest = null;
      }
    });

    proc.on('error', (err) => {
      this.logInfo(`Persistent process error: ${err.message}`);
      this.persistentProc = null;
      this.currentModel = null;
      this.ready = false;
      this.busy = false;
      if (this.pendingRequest) {
        this.pendingRequest.resolve(null);
        this.pendingRequest = null;
      }
    });
  }

  private processLines(): void {
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: { type: string; subtype?: string; message?: { content?: Array<{ text?: string }> }; result?: string; duration_ms?: number };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.logInfo(`Non-JSON line: ${trimmed.slice(0, 200)}`);
        continue;
      }

      this.logInfo(`Parsed message: type=${msg.type}${msg.subtype ? `, subtype=${msg.subtype}` : ''}`);

      if (msg.type === 'system' && msg.subtype === 'init') {
        if (!this.ready) {
          this.ready = true;
          this.logInfo('Persistent process ready');
        }
        continue;
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.text) {
            this.assistantText = block.text;
          }
        }
        continue;
      }

      if (msg.type === 'result') {
        const pending = this.pendingRequest;
        this.pendingRequest = null;
        this.busy = false;

        if (pending) {
          const elapsed = Date.now() - pending.startTime;
          const resultText = msg.result ?? this.assistantText;

          if (pending.cancelled) {
            this.logInfo(`Completion discarded (cancelled): ${elapsed}ms`);
            pending.resolve(null);
          } else if (resultText) {
            this.logInfo(`Completion success: ${elapsed}ms, ${resultText.length} chars${msg.duration_ms ? ` (api: ${msg.duration_ms}ms)` : ''}`);
            pending.resolve(resultText);
          } else {
            this.logInfo(`Completion empty: ${elapsed}ms`);
            pending.resolve(null);
          }
        }
        this.assistantText = '';
        continue;
      }
    }
  }

  async spawnCompletion(
    prompt: string,
    model: ModelTier,
    token?: CancellationToken
  ): Promise<string | null> {
    if (token?.isCancellationRequested) return null;

    this.ensureProcess(model);

    // If busy with a previous request, mark it cancelled and wait
    if (this.busy && this.pendingRequest) {
      this.logInfo('Cancelling previous in-flight request (new request arrived)');
      this.pendingRequest.cancelled = true;
      await new Promise<void>((resolve) => {
        const oldResolve = this.pendingRequest!.resolve;
        this.pendingRequest!.resolve = (result) => {
          oldResolve(result);
          resolve();
        };
      });
    }

    if (token?.isCancellationRequested) return null;

    if (!this.persistentProc || this.persistentProc.killed) {
      this.logInfo('Persistent process not available, falling back to one-shot');
      return this.oneShot(prompt, model, token);
    }

    const startTime = Date.now();
    this.logInfo(`Completion request (persistent): model=${model}, prompt=${prompt.length} chars`);

    return new Promise<string | null>((resolve) => {
      this.busy = true;
      this.assistantText = '';
      this.pendingRequest = { resolve, cancelled: false, startTime };

      const cancelListener = token?.onCancellationRequested(() => {
        if (this.pendingRequest && this.pendingRequest.resolve === resolve) {
          this.pendingRequest.cancelled = true;
        }
      });

      const originalResolve = resolve;
      this.pendingRequest.resolve = (result) => {
        cancelListener?.dispose();
        originalResolve(result);
      };

      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      });

      this.persistentProc!.stdin?.write(msg + '\n');
    });
  }

  private async oneShot(
    prompt: string,
    model: ModelTier,
    token?: CancellationToken
  ): Promise<string | null> {
    const timeoutMs = MODEL_CONFIGS[model].timeoutMs;
    const startTime = Date.now();
    this.logInfo(`Completion request (one-shot fallback): model=${model}, prompt=${prompt.length} chars`);

    return new Promise<string | null>((resolve) => {
      const args = [
        '-p', '-',
        '--model', model,
        '--output-format', 'json',
        '--append-system-prompt', SYSTEM_PROMPT,
        '--bare',
      ];

      let proc: ChildProcess;
      try {
        proc = spawn(this.cliPath, args, { shell: false, timeout: timeoutMs });
      } catch {
        resolve(null);
        return;
      }

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      if (token?.isCancellationRequested) {
        proc.kill();
        resolve(null);
        return;
      }

      const cancelListener = token?.onCancellationRequested(() => {
        proc.kill();
        resolve(null);
      });

      let stdout = '';
      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.on('close', (code) => {
        cancelListener?.dispose();
        const elapsed = Date.now() - startTime;
        if (token?.isCancellationRequested || code !== 0) {
          this.logInfo(`One-shot ${token?.isCancellationRequested ? 'cancelled' : 'failed'}: ${elapsed}ms`);
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const result = parsed.result ?? stdout.trim();
          this.logInfo(`One-shot success: ${elapsed}ms, ${result.length} chars`);
          resolve(result);
        } catch {
          const trimmed = stdout.trim();
          resolve(trimmed || null);
        }
      });
      proc.on('error', () => { cancelListener?.dispose(); resolve(null); });
    });
  }

  buildPrompt(
    currentFile: FileContext,
    cursorLine: number,
    cursorCol: number,
    openTabs: FileContext[] = [],
    recentEdits: EditEntry[] = [],
    fileSwitchHistory: FileSwitchEntry[] = [],
    feedbackSummary: string = ''
  ): string {
    const lines = currentFile.content.split('\n');
    const cursorOffset = cursorLine - currentFile.startLine;
    const before = lines.slice(0, cursorOffset).join('\n');
    const after = lines.slice(cursorOffset).join('\n');

    let prompt = `File: ${currentFile.uri} | Line ${cursorLine}, Col ${cursorCol} | Language: ${currentFile.languageId}\n\n`;
    prompt += `--- Code Context ---\n${before}\n[CURSOR]\n${after}\n`;

    if (openTabs.length > 0) {
      prompt += '\n--- Open Tabs ---\n';
      for (const tab of openTabs) {
        prompt += `\n// ${tab.uri} (${tab.languageId})\n${tab.content}\n`;
      }
    }

    if (recentEdits.length > 0) {
      prompt += '\n--- Recent Edits ---\n';
      for (const edit of recentEdits) {
        const ct = getChangeType(edit);
        const time = formatTimeAgo(edit.timestamp);
        const fileName = edit.uri.split(/[/\\]/).pop() ?? edit.uri;
        const snippet = edit.text.slice(0, 100).replace(/\n/g, '\\n');
        prompt += `[${time}] ${fileName}:L${edit.startLine}-L${edit.endLine} ${ct} "${snippet}"\n`;
      }
    }

    if (fileSwitchHistory.length > 0) {
      prompt += '\n--- File Navigation ---\n';
      const recent = fileSwitchHistory.slice(-5);
      for (const sw of recent) {
        const from = sw.fromUri?.split(/[/\\]/).pop() ?? '(start)';
        const to = sw.toUri.split(/[/\\]/).pop() ?? sw.toUri;
        prompt += `${formatTimeAgo(sw.timestamp)}: ${from} -> ${to}\n`;
      }
    }

    if (feedbackSummary) {
      prompt += `\n--- Completion History ---\n${feedbackSummary}\n`;
    }

    prompt += '\nInsert code at [CURSOR].';
    return prompt;
  }

  killPersistentProcess(): void {
    if (this.persistentProc) {
      this.logInfo('Killing persistent process');
      try {
        this.persistentProc.stdin?.end();
        this.persistentProc.kill();
      } catch {
        // Process may already be dead
      }
      this.persistentProc = null;
      this.currentModel = null;
      this.ready = false;
      this.busy = false;
      if (this.pendingRequest) {
        this.pendingRequest.resolve(null);
        this.pendingRequest = null;
      }
    }
  }

  killActiveProcess(): void {
    this.killPersistentProcess();
  }
}
