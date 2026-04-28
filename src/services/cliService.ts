import { spawn, ChildProcess } from 'child_process';
import { CancellationToken, OutputChannel } from 'vscode';
import { ModelTier, MODEL_CONFIGS, FileContext, EditEntry, FileSwitchEntry } from '../models/types';

const SYSTEM_PROMPT = [
  'You are an inline code completion engine. Return ONLY raw code to insert at the cursor.',
  'No explanations, markdown, code fences, or surrounding prose.',
  'Prefer the smallest useful completion: one token, expression, statement, or at most three short lines.',
  'Never repeat code that already exists immediately before or after the cursor.',
  'Match indentation, quotes, semicolons, naming, and the surrounding style.',
  'If no high-confidence completion is useful, return an empty string.',
].join('\n');

const COMPLETION_TIMEOUT_MS = 15_000;
const PRIME_TIMEOUT_MS = 30_000;
const MEMORY_UPDATE_TIMEOUT_MS = 8000;
const EARLY_COMPLETION_SETTLE_MS = 90;

type RequestKind = 'completion' | 'prime' | 'memory';
type WorkerRole = 'completion' | 'memory';

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
  kind: RequestKind;
  deadline: ReturnType<typeof setTimeout> | null;
  earlyDeadline: ReturnType<typeof setTimeout> | null;
}

interface Worker {
  id: number;
  role: WorkerRole;
  proc: ChildProcess | null;
  model: ModelTier;
  busy: boolean;
  primed: boolean;
  pendingRequest: PendingRequest | null;
  lineBuffer: string;
  assistantText: string;
}

interface StreamMessage {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{ text?: string }>;
  };
  result?: string;
  duration_ms?: number;
}

export class CliService {
  private workers: Record<WorkerRole, Worker | null> = {
    completion: null,
    memory: null,
  };
  private cliPath: string = 'claude';
  private lastDetection: CliDetectionResult | null = null;
  private log: OutputChannel | null = null;
  private nextWorkerId = 0;
  private primePayload: string | null = null;
  private primeModel: ModelTier | null = null;

  setOutputChannel(channel: OutputChannel): void {
    this.log = channel;
  }

  private logInfo(msg: string): void {
    this.log?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  setCliPath(path: string): void {
    this.cliPath = path || 'claude';
    this.logInfo(`CLI path set to: ${this.cliPath}`);
    this.killActiveProcess();
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

      proc.on('close', (code: number | null) => {
        const result: CliDetectionResult = {
          available: code === 0,
          version: code === 0 ? stdout.trim() : null,
          path: this.cliPath,
        };
        this.lastDetection = result;
        this.logInfo(`CLI detection: ${result.available ? `found v${result.version}` : `not found (exit ${code})`}`);
        resolve(result);
      });

      proc.on('error', (err: Error) => {
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

  private spawnWorker(role: WorkerRole, model: ModelTier): Worker {
    const id = this.nextWorkerId++;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', model,
      '--effort', 'low',
      '--no-session-persistence',
      '--tools', '',
      '--system-prompt', SYSTEM_PROMPT,
    ];

    this.logInfo(`Worker ${id}: spawning (${role}, model=${model})`);
    const proc = spawn(this.cliPath, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const worker: Worker = {
      id,
      role,
      proc,
      model,
      busy: false,
      primed: false,
      pendingRequest: null,
      lineBuffer: '',
      assistantText: '',
    };

    this.logInfo(`Worker ${id}: spawned (${role}) pid=${proc.pid}`);

    proc.stdout?.on('data', (data: Buffer) => {
      worker.lineBuffer += data.toString();
      this.processWorkerLines(worker);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.logInfo(`Worker ${id} stderr: ${text.slice(0, 500)}`);
    });

    proc.on('close', (code: number | null) => {
      this.logInfo(`Worker ${id} exited code=${code}`);
      this.finishWorker(worker, null, true);
      worker.proc = null;
      worker.busy = false;
      worker.primed = false;
      if (this.workers[worker.role] === worker) {
        this.workers[worker.role] = null;
      }
    });

    proc.on('error', (err: Error) => {
      this.logInfo(`Worker ${id} error: ${err.message}`);
      this.finishWorker(worker, null, true);
      worker.proc = null;
      worker.busy = false;
      worker.primed = false;
      if (this.workers[worker.role] === worker) {
        this.workers[worker.role] = null;
      }
    });

    return worker;
  }

  private ensureWorker(role: WorkerRole, model: ModelTier): Worker {
    const worker = this.workers[role];
    if (worker?.proc && !worker.proc.killed && worker.model === model) {
      return worker;
    }

    if (worker) {
      this.stopWorker(worker, 'model/path changed');
    }

    this.workers[role] = this.spawnWorker(role, model);
    return this.workers[role];
  }

  private async ensurePrimed(worker: Worker): Promise<boolean> {
    if (worker.primed) return true;
    if (!this.primePayload || this.primeModel !== worker.model) return true;
    if (worker.busy) return false;
    const result = await this.dispatch(worker, this.primePayload, 'prime', PRIME_TIMEOUT_MS);
    return result !== null;
  }

  private finishWorker(worker: Worker, result: string | null, force: boolean = false): void {
    const pending = worker.pendingRequest;
    if (!pending) return;

    if (pending.deadline) {
      clearTimeout(pending.deadline);
      pending.deadline = null;
    }
    if (pending.earlyDeadline) {
      clearTimeout(pending.earlyDeadline);
      pending.earlyDeadline = null;
    }

    worker.pendingRequest = null;
    worker.busy = false;
    pending.resolve(force || !pending.cancelled ? result : null);
  }

  private stopWorker(worker: Worker, reason: string): void {
    this.logInfo(`Worker ${worker.id}: stopping (${reason})`);
    this.finishWorker(worker, null, true);
    worker.primed = false;

    if (worker.proc && !worker.proc.killed) {
      try {
        worker.proc.stdin?.end();
        worker.proc.kill();
      } catch {
        // best effort
      }
    }

    worker.proc = null;
    worker.busy = false;
    if (this.workers[worker.role] === worker) {
      this.workers[worker.role] = null;
    }
  }

  private processWorkerLines(worker: Worker): void {
    const lines = worker.lineBuffer.split('\n');
    worker.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: StreamMessage;
      try {
        msg = JSON.parse(trimmed) as StreamMessage;
      } catch {
        this.logInfo(`Worker ${worker.id}: non-JSON line: ${trimmed.slice(0, 200)}`);
        continue;
      }

      if (msg.type === 'system' && msg.subtype === 'init') {
        continue;
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.text !== undefined) {
            worker.assistantText = block.text;
          }
        }
        this.scheduleEarlyCompletion(worker);
        continue;
      }

      if (msg.type !== 'result') {
        continue;
      }

      const pending = worker.pendingRequest;
      if (!pending) {
        worker.assistantText = '';
        worker.busy = false;
        continue;
      }

      const elapsed = Date.now() - pending.startTime;
      const resultText = msg.result ?? worker.assistantText;
      const tag = pending.kind;

      if (pending.cancelled) {
        this.logInfo(`Worker ${worker.id}: ${tag} discarded (cancelled): ${elapsed}ms`);
        this.finishWorker(worker, null, true);
      } else if (resultText !== undefined) {
        this.logInfo(`Worker ${worker.id}: ${tag} success: ${elapsed}ms, ${resultText.length} chars${msg.duration_ms ? ` (api: ${msg.duration_ms}ms)` : ''}`);
        if (pending.kind === 'prime' || pending.kind === 'memory') {
          worker.primed = true;
        }
        this.finishWorker(worker, resultText);
      } else {
        this.logInfo(`Worker ${worker.id}: ${tag} empty: ${elapsed}ms`);
        this.finishWorker(worker, null);
      }

      worker.assistantText = '';
    }
  }

  private dispatch(
    worker: Worker,
    prompt: string,
    kind: RequestKind,
    timeoutMs: number,
    token?: CancellationToken
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (!worker.proc || worker.proc.killed || worker.busy) {
        resolve(null);
        return;
      }

      worker.busy = true;
      worker.assistantText = '';
      let settled = false;

      const wrappedResolve = (result: string | null) => {
        if (settled) return;
        settled = true;
        cancelListener?.dispose();
        resolve(result);
      };

      const pending: PendingRequest = {
        resolve: wrappedResolve,
        cancelled: false,
        startTime: Date.now(),
        kind,
        deadline: null,
        earlyDeadline: null,
      };

      const cancelListener = token?.onCancellationRequested(() => {
        if (worker.pendingRequest === pending) {
          pending.cancelled = true;
          // Don't kill the worker — let the in-flight reply drain so the
          // primed conversation stays intact. Resolve caller immediately.
          wrappedResolve(null);
        }
      });

      pending.deadline = setTimeout(() => {
        if (worker.pendingRequest !== pending) return;
        const elapsed = Date.now() - pending.startTime;
        this.logInfo(`Worker ${worker.id}: ${kind} timeout after ${elapsed}ms`);
        if (kind === 'completion') {
          pending.cancelled = true;
          this.stopWorker(worker, `${kind} timeout`);
          return;
        }
        this.stopWorker(worker, `${kind} timeout`);
        wrappedResolve(null);
      }, timeoutMs);

      worker.pendingRequest = pending;

      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      });
      worker.proc.stdin?.write(msg + '\n');
    });
  }

  private scheduleEarlyCompletion(worker: Worker): void {
    const pending = worker.pendingRequest;
    if (!pending || pending.kind !== 'completion' || pending.cancelled) return;
    if (pending.earlyDeadline) return;
    if (!worker.assistantText.trim()) return;

    pending.earlyDeadline = setTimeout(() => {
      pending.earlyDeadline = null;
      if (worker.pendingRequest !== pending || pending.cancelled) return;

      const text = worker.assistantText;
      if (!text.trim()) return;

      const elapsed = Date.now() - pending.startTime;
      this.logInfo(`Worker ${worker.id}: completion early result: ${elapsed}ms, ${text.length} chars`);
      pending.resolve(text);
      this.stopWorker(worker, 'completion early result');
    }, EARLY_COMPLETION_SETTLE_MS);
  }

  async spawnCompletion(
    prompt: string,
    model: ModelTier,
    token?: CancellationToken,
    opts: { isPrime?: boolean } = {}
  ): Promise<string | null> {
    if (token?.isCancellationRequested) return null;

    const worker = this.ensureWorker('completion', model);
    const kind: RequestKind = opts.isPrime ? 'prime' : 'completion';

    if (worker.busy) {
      this.logInfo(`Worker ${worker.id}: ${kind} skipped (busy with ${worker.pendingRequest?.kind ?? 'unknown'})`);
      return null;
    }

    if (!opts.isPrime && !worker.primed && this.primePayload && this.primeModel === model) {
      this.logInfo(`Worker ${worker.id}: auto-priming before completion`);
      await this.ensurePrimed(worker);
      if (token?.isCancellationRequested) return null;
      if (worker.busy) return null;
    }

    const timeoutMs = opts.isPrime
      ? PRIME_TIMEOUT_MS
      : Math.min(COMPLETION_TIMEOUT_MS, MODEL_CONFIGS[model].timeoutMs);

    this.logInfo(`Worker ${worker.id}: ${kind} request, model=${model}, prompt=${prompt.length} chars`);
    return this.dispatch(worker, prompt, kind, timeoutMs, token);
  }

  async primeAllWorkers(payload: string, model: ModelTier): Promise<boolean> {
    this.primePayload = payload;
    this.primeModel = model;

    const targets: WorkerRole[] = ['memory', 'completion'];
    const results = await Promise.all(
      targets.map(async (role) => {
        const worker = this.ensureWorker(role, model);
        if (worker.busy) {
          this.logInfo(`Worker ${worker.id}: prime skipped (busy with ${worker.pendingRequest?.kind ?? 'unknown'})`);
          return false;
        }
        const result = await this.dispatch(worker, payload, 'prime', PRIME_TIMEOUT_MS);
        return result !== null;
      })
    );
    return results.some(Boolean);
  }

  async sendMemoryUpdate(payload: string, model: ModelTier): Promise<boolean> {
    const worker = this.ensureWorker('memory', model);
    if (worker.busy) {
      this.logInfo(`Worker ${worker.id}: memory skipped (busy with ${worker.pendingRequest?.kind ?? 'unknown'})`);
      return false;
    }

    if (!worker.primed && this.primePayload && this.primeModel === model) {
      this.logInfo(`Worker ${worker.id}: auto-priming before memory update`);
      const ok = await this.ensurePrimed(worker);
      if (!ok || worker.busy) return false;
    }

    const result = await this.dispatch(worker, payload, 'memory', MEMORY_UPDATE_TIMEOUT_MS);
    return result !== null;
  }

  isAnyWorkerPrimed(model: ModelTier): boolean {
    return this.isWorkerPrimed('completion', model) || this.isWorkerPrimed('memory', model);
  }

  isAllWorkersPrimed(model: ModelTier): boolean {
    return this.isWorkerPrimed('completion', model) && this.isWorkerPrimed('memory', model);
  }

  isCompletionWorkerPrimed(model: ModelTier): boolean {
    return this.isWorkerPrimed('completion', model);
  }

  private isWorkerPrimed(role: WorkerRole, model: ModelTier): boolean {
    const worker = this.workers[role];
    return worker?.model === model && !!worker.proc && !worker.proc.killed && worker.primed;
  }

  isBusy(model?: ModelTier): boolean {
    return this.isRoleBusy('completion', model);
  }

  isMemoryBusy(model?: ModelTier): boolean {
    return this.isRoleBusy('memory', model);
  }

  private isRoleBusy(role: WorkerRole, model?: ModelTier): boolean {
    const worker = this.workers[role];
    if (!worker?.proc || worker.proc.killed) return false;
    if (model && worker.model !== model) return false;
    return worker.busy;
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
    const cursorOffset = Math.max(0, cursorLine - currentFile.startLine);
    const currentLine = lines[cursorOffset] ?? '';
    const beforeParts = [
      ...lines.slice(0, cursorOffset),
      currentLine.slice(0, cursorCol),
    ];
    const afterParts = [
      currentLine.slice(cursorCol),
      ...lines.slice(cursorOffset + 1),
    ];
    const before = beforeParts.join('\n');
    const after = afterParts.join('\n');

    let prompt = `COMPLETE ${currentFile.uri} L${cursorLine + 1}:C${cursorCol} ${currentFile.languageId}\n`;
    prompt += 'Return only insert text. Prefer <=3 short lines.\n\n';
    prompt += `${before}\n[CURSOR]\n${after}\n`;

    if (openTabs.length > 0) {
      prompt += '\nOpen tabs:\n';
      for (const tab of openTabs.slice(0, 3)) {
        prompt += `\n${tab.uri} (${tab.languageId})\n${tab.content.slice(0, 1200)}\n`;
      }
    }

    if (recentEdits.length > 0) {
      prompt += '\nRecent edits:\n';
      for (const edit of recentEdits.slice(-5)) {
        const ct = getChangeType(edit);
        const time = formatTimeAgo(edit.timestamp);
        const fileName = edit.uri.split(/[/\\]/).pop() ?? edit.uri;
        const snippet = edit.text.slice(0, 80).replace(/\n/g, '\\n');
        prompt += `${time} ${fileName}:L${edit.startLine + 1}-${edit.endLine + 1} ${ct} "${snippet}"\n`;
      }
    }

    if (fileSwitchHistory.length > 0) {
      const recent = fileSwitchHistory.slice(-3);
      prompt += '\nNavigation:\n';
      for (const sw of recent) {
        const from = sw.fromUri?.split(/[/\\]/).pop() ?? '(start)';
        const to = sw.toUri.split(/[/\\]/).pop() ?? sw.toUri;
        prompt += `${formatTimeAgo(sw.timestamp)} ${from} -> ${to}\n`;
      }
    }

    if (feedbackSummary) {
      prompt += `\n${feedbackSummary}\n`;
    }

    return prompt;
  }

  killActiveProcess(): void {
    for (const role of Object.keys(this.workers) as WorkerRole[]) {
      const worker = this.workers[role];
      if (worker) {
        this.stopWorker(worker, 'shutdown');
      }
      this.workers[role] = null;
    }
  }
}
