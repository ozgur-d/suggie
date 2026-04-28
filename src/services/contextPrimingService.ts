import * as vscode from 'vscode';
import { CliService } from './cliService';
import { ModelTier } from '../models/types';

interface PrimedFile {
  uri: string;
  version: number;
  lineCount: number;
  primedAt: number;
}

interface PendingDocumentUpdate {
  document: vscode.TextDocument;
  changes: vscode.TextDocumentContentChangeEvent[];
}

const MAX_FILES_PER_BATCH = 14;
const MAX_LINES_PER_FILE = 220;
const MAX_CHARS_PER_FILE = 8_000;
const MAX_TOTAL_CHARS = 56_000; // ~14k tokens — comfortably above the 10k floor
const MAX_PROJECT_FILES = 120;
const MAX_PROJECT_TREE_CHARS = 4_000;
const MAX_README_LINES = 80;
const MAX_PACKAGE_JSON_CHARS = 2_400;
const MAX_TSCONFIG_CHARS = 1_200;
const MAX_RECENT_FILES = 4;
const MAX_RECENT_FILE_CHARS = 4_000;
const MIN_PRIME_TARGET_CHARS = 40_000; // ~10k token guarantee
const MAX_UPDATE_FILES = 3;
const MAX_CHANGES_PER_FILE = 6;
const MAX_CHANGE_TEXT_CHARS = 280;
const UPDATE_DEBOUNCE_MS = 5_000;
const UPDATE_RETRY_MS = 1_500;
const PROJECT_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,cpp,c,h,hpp,rb,php,swift,vue,svelte}';
const PROJECT_EXCLUDE = '**/{node_modules,dist,out,build,.git,.next,.cache,coverage}/**';

export class ContextPrimingService implements vscode.Disposable {
  private primedFiles = new Map<string, PrimedFile>();
  private disposables: vscode.Disposable[] = [];
  private pendingUpdates = new Map<string, PendingDocumentUpdate>();
  private log: vscode.OutputChannel | null = null;
  private initialPrimeFired = false;
  private trackingStarted = false;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private regexCache = new Map<string, RegExp>();
  private cachedPatterns: string[] | null = null;

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
    if (this.trackingStarted) return;
    this.trackingStarted = true;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || editor.document.uri.scheme !== 'file') return;
        void this.primeDocument(editor.document);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;
        if (e.contentChanges.length === 0) return;
        this.scheduleUpdate(e.document, e.contentChanges);
      })
    );

    void this.primeOpenTabs();
  }

  isFilePrimed(uri: string): boolean {
    return this.primedFiles.has(uri);
  }

  getPrimedFile(uri: string): PrimedFile | undefined {
    return this.primedFiles.get(uri);
  }

  async executeCompletion<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  resetOnProcessRestart(): void {
    this.primedFiles.clear();
    this.pendingUpdates.clear();
    this.initialPrimeFired = false;
    this.logInfo('Cleared all primed files (process restart)');
    void this.primeOpenTabs();
  }

  private compiledPatterns(): RegExp[] {
    const patterns = this.getExcludePatterns();
    if (this.cachedPatterns !== patterns) {
      this.regexCache.clear();
      this.cachedPatterns = patterns;
    }
    const out: RegExp[] = [];
    for (const pattern of patterns) {
      let regex = this.regexCache.get(pattern);
      if (!regex) {
        const escaped =
          '^' +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$';
        regex = new RegExp(escaped);
        this.regexCache.set(pattern, regex);
      }
      out.push(regex);
    }
    return out;
  }

  private isExcluded(filePath: string): boolean {
    const fileName = filePath.split(/[/\\]/).pop() ?? '';
    return this.compiledPatterns().some((r) => r.test(fileName));
  }

  private collectOpenDocuments(): vscode.TextDocument[] {
    const seen = new Set<string>();
    const docs: vscode.TextDocument[] = [];
    const active = vscode.window.activeTextEditor?.document;
    if (active && active.uri.scheme === 'file' && !this.isExcluded(active.uri.fsPath)) {
      seen.add(active.uri.toString());
      docs.push(active);
    }

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText)) continue;
        const key = input.uri.toString();
        if (seen.has(key)) continue;
        if (input.uri.scheme !== 'file') continue;
        if (this.isExcluded(input.uri.fsPath)) continue;
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        if (!doc) continue;
        seen.add(key);
        docs.push(doc);
        if (docs.length >= MAX_FILES_PER_BATCH) return docs;
      }
    }
    return docs;
  }

  private formatFileSection(doc: vscode.TextDocument): string {
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const totalLines = doc.lineCount;
    const sliceLines = Math.min(totalLines, MAX_LINES_PER_FILE);
    const truncated = totalLines > sliceLines;
    const header = `=== file: ${relativePath} (${doc.languageId}, ${totalLines} lines${truncated ? `, showing first ${sliceLines}` : ''}, v${doc.version}) ===`;
    const out: string[] = [header];

    for (let i = 0; i < sliceLines; i++) {
      out.push(`L${i + 1}: ${doc.lineAt(i).text}`);
    }
    if (truncated) {
      out.push(`... [${totalLines - sliceLines} more lines truncated]`);
    }

    const section = out.join('\n');
    if (section.length <= MAX_CHARS_PER_FILE) return section;
    return `${section.slice(0, MAX_CHARS_PER_FILE)}\n... [file truncated by character budget]`;
  }

  private async primeOpenTabs(): Promise<void> {
    if (this.initialPrimeFired) return;
    this.initialPrimeFired = true;

    const { prompt, includedDocs, totalChars } = await this.buildInitialPrimePayload();
    if (!prompt) {
      this.initialPrimeFired = false;
      this.logInfo('No primeable workspace content available yet');
      return;
    }

    this.logInfo(
      `Initial prime: ${includedDocs.length} editor file(s), ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`
    );

    const start = Date.now();
    const ok = await this.cliService.primeAllWorkers(prompt, this.getModel());
    const now = Date.now();

    if (!ok) {
      this.initialPrimeFired = false;
      this.logInfo(`Initial prime did not complete in ${now - start}ms`);
      return;
    }

    for (const doc of includedDocs) {
      this.markPrimed(doc, now);
    }
    this.logInfo(`Initial prime complete in ${now - start}ms`);
  }

  private async buildInitialPrimePayload(): Promise<{
    prompt: string;
    includedDocs: vscode.TextDocument[];
    totalChars: number;
  }> {
    const sections: string[] = [];
    let totalChars = 0;
    const folders = vscode.workspace.workspaceFolders ?? [];

    const header: string[] = ['[CONTEXT PRIME]'];
    header.push(
      'You are an inline code-completion engine for this VS Code workspace.'
    );
    header.push(
      'Cache this entire briefing. Subsequent messages will reference files by path,'
    );
    header.push('add small diffs, and ask for completion at a cursor position.');
    header.push('Reply now with only: OK');

    if (folders.length > 0) {
      const summary = folders
        .map((f) => `- ${f.name} (${f.uri.fsPath})`)
        .join('\n');
      header.push('', '== Workspace ==', summary);
    }

    sections.push(header.join('\n'));
    totalChars += sections[0].length;

    const projectMeta = await this.collectProjectMetadata();
    if (projectMeta) {
      sections.push(projectMeta);
      totalChars += projectMeta.length;
    }

    const projectTree = await this.collectProjectTree();
    if (projectTree) {
      sections.push(projectTree);
      totalChars += projectTree.length;
    }

    const recentFiles = await this.collectRecentFileSections();
    if (recentFiles) {
      sections.push(recentFiles);
      totalChars += recentFiles.length;
    }

    const docs = this.collectOpenDocuments();
    const includedDocs: vscode.TextDocument[] = [];
    if (docs.length > 0) {
      const editorSections: string[] = ['== Open Editor Files =='];
      for (const doc of docs) {
        const section = this.formatFileSection(doc);
        const projected = totalChars + section.length + editorSections.join('\n\n').length;
        if (projected > MAX_TOTAL_CHARS && includedDocs.length > 0) break;
        editorSections.push(section);
        includedDocs.push(doc);
        if (totalChars + editorSections.join('\n\n').length > MAX_TOTAL_CHARS) break;
      }
      if (editorSections.length > 1) {
        const block = editorSections.join('\n\n');
        sections.push(block);
        totalChars += block.length;
      }
    }

    if (totalChars < MIN_PRIME_TARGET_CHARS) {
      const filler = await this.collectAdditionalProjectFiles(
        new Set(includedDocs.map((d) => d.uri.toString())),
        MIN_PRIME_TARGET_CHARS - totalChars
      );
      if (filler) {
        sections.push(filler);
        totalChars += filler.length;
      }
    }

    if (includedDocs.length === 0 && sections.length <= 1) {
      return { prompt: '', includedDocs: [], totalChars: 0 };
    }

    const prompt = sections.join('\n\n');
    return { prompt, includedDocs, totalChars: prompt.length };
  }

  private async readWorkspaceFile(name: string, maxChars: number): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const uri = vscode.Uri.joinPath(folders[0].uri, name);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      if (text.length <= maxChars) return text;
      return `${text.slice(0, maxChars)}\n... [truncated]`;
    } catch {
      return null;
    }
  }

  private async collectProjectMetadata(): Promise<string | null> {
    const parts: string[] = [];

    const pkg = await this.readWorkspaceFile('package.json', MAX_PACKAGE_JSON_CHARS);
    if (pkg) {
      parts.push(`=== package.json ===\n${pkg}`);
    }

    const tsconfig = await this.readWorkspaceFile('tsconfig.json', MAX_TSCONFIG_CHARS);
    if (tsconfig) {
      parts.push(`=== tsconfig.json ===\n${tsconfig}`);
    }

    const readme = await this.readWorkspaceFile('README.md', 6_000);
    if (readme) {
      const trimmed = readme.split('\n').slice(0, MAX_README_LINES).join('\n');
      parts.push(`=== README.md (first ${MAX_README_LINES} lines) ===\n${trimmed}`);
    }

    if (parts.length === 0) return null;
    return ['== Project Metadata ==', ...parts].join('\n\n');
  }

  private async collectProjectTree(): Promise<string | null> {
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        PROJECT_GLOB,
        PROJECT_EXCLUDE,
        MAX_PROJECT_FILES
      );
    } catch (err) {
      this.logInfo(`Project tree scan failed: ${(err as Error).message}`);
      return null;
    }
    if (uris.length === 0) return null;

    const lines: string[] = [];
    let chars = 0;
    for (const uri of uris) {
      if (this.isExcluded(uri.fsPath)) continue;
      const rel = vscode.workspace.asRelativePath(uri);
      const line = `- ${rel}`;
      if (chars + line.length + 1 > MAX_PROJECT_TREE_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
    }
    if (lines.length === 0) return null;
    return `== File Tree (top ${lines.length} source files) ==\n${lines.join('\n')}`;
  }

  private async collectRecentFileSections(): Promise<string | null> {
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(PROJECT_GLOB, PROJECT_EXCLUDE, 60);
    } catch {
      return null;
    }
    if (uris.length === 0) return null;

    const stats = await Promise.all(
      uris.map(async (uri) => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          return { uri, mtime: stat.mtime };
        } catch {
          return null;
        }
      })
    );

    const sorted = stats
      .filter((s): s is { uri: vscode.Uri; mtime: number } => s !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_RECENT_FILES);

    if (sorted.length === 0) return null;

    const sections: string[] = ['== Recently Modified Files =='];
    let chars = 0;
    for (const { uri } of sorted) {
      if (this.isExcluded(uri.fsPath)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const trimmed =
          text.length > MAX_RECENT_FILE_CHARS
            ? `${text.slice(0, MAX_RECENT_FILE_CHARS)}\n... [truncated]`
            : text;
        const rel = vscode.workspace.asRelativePath(uri);
        const block = `=== ${rel} ===\n${trimmed}`;
        if (chars + block.length > MAX_RECENT_FILES * MAX_RECENT_FILE_CHARS) break;
        sections.push(block);
        chars += block.length;
      } catch {
        // skip unreadable
      }
    }
    if (sections.length <= 1) return null;
    return sections.join('\n\n');
  }

  private async collectAdditionalProjectFiles(
    skip: Set<string>,
    budget: number
  ): Promise<string | null> {
    if (budget <= 0) return null;
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(PROJECT_GLOB, PROJECT_EXCLUDE, 80);
    } catch {
      return null;
    }
    const sections: string[] = ['== Additional Source Files =='];
    let chars = sections[0].length;
    for (const uri of uris) {
      if (skip.has(uri.toString())) continue;
      if (this.isExcluded(uri.fsPath)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const cap = Math.min(MAX_CHARS_PER_FILE, budget - chars);
        if (cap < 600) break;
        const trimmed = text.length > cap ? `${text.slice(0, cap)}\n... [truncated]` : text;
        const rel = vscode.workspace.asRelativePath(uri);
        const block = `=== ${rel} ===\n${trimmed}`;
        sections.push(block);
        chars += block.length + 2;
        if (chars >= budget) break;
      } catch {
        // skip
      }
    }
    if (sections.length <= 1) return null;
    return sections.join('\n\n');
  }

  private async primeDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') return;
    if (this.isExcluded(document.uri.fsPath)) return;

    const uri = document.uri.toString();
    const existing = this.primedFiles.get(uri);
    if (existing && existing.version === document.version) return;
    if (this.cliService.isMemoryBusy(this.getModel())) return;

    const section = this.formatFileSection(document);
    const prompt =
      `[CONTEXT ADD]\n` +
      `Cache or refresh this editor file for inline completion. Reply with only: OK\n\n` +
      section;

    this.logInfo(`Prime file: ${vscode.workspace.asRelativePath(document.uri)} (${section.length} chars)`);
    const ok = await this.cliService.sendMemoryUpdate(prompt, this.getModel());
    if (ok) {
      this.markPrimed(document, Date.now());
    }
  }

  private scheduleUpdate(
    document: vscode.TextDocument,
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): void {
    if (this.isExcluded(document.uri.fsPath)) return;

    const uri = document.uri.toString();
    const existing = this.pendingUpdates.get(uri);
    const merged = [
      ...(existing?.changes ?? []),
      ...changes,
    ].slice(-MAX_CHANGES_PER_FILE);

    this.pendingUpdates.set(uri, {
      document,
      changes: merged,
    });

    this.scheduleFlush(UPDATE_DEBOUNCE_MS);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      void this.flushPendingUpdates();
    }, delayMs);
  }

  private async flushPendingUpdates(): Promise<void> {
    if (this.pendingUpdates.size === 0) return;

    if (this.cliService.isMemoryBusy(this.getModel())) {
      this.scheduleFlush(UPDATE_RETRY_MS);
      return;
    }

    const selected = Array.from(this.pendingUpdates.entries()).slice(0, MAX_UPDATE_FILES);
    for (const [uri] of selected) {
      this.pendingUpdates.delete(uri);
    }

    const prompt = this.buildUpdatePrompt(selected.map(([, value]) => value));
    if (!prompt) {
      if (this.pendingUpdates.size > 0) this.scheduleFlush(UPDATE_DEBOUNCE_MS);
      return;
    }

    const ok = await this.cliService.sendMemoryUpdate(prompt, this.getModel());
    if (ok) {
      const now = Date.now();
      for (const [, update] of selected) {
        this.markPrimed(update.document, now);
      }
    } else {
      for (const [uri, update] of selected) {
        const existing = this.pendingUpdates.get(uri);
        this.pendingUpdates.set(uri, {
          document: update.document,
          changes: [...(existing?.changes ?? []), ...update.changes].slice(-MAX_CHANGES_PER_FILE),
        });
      }
    }

    if (this.pendingUpdates.size > 0) {
      this.scheduleFlush(ok ? UPDATE_DEBOUNCE_MS : UPDATE_RETRY_MS);
    }
  }

  private buildUpdatePrompt(updates: PendingDocumentUpdate[]): string {
    const sections: string[] = [];

    for (const update of updates) {
      const relativePath = vscode.workspace.asRelativePath(update.document.uri);
      const primed = this.primedFiles.get(update.document.uri.toString());
      if (!primed) {
        continue;
      }

      const lines = [`file: ${relativePath} v${update.document.version}`];
      for (const change of update.changes.slice(-MAX_CHANGES_PER_FILE)) {
        const type = this.changeType(change);
        const text = change.text
          .slice(0, MAX_CHANGE_TEXT_CHARS)
          .replace(/\r/g, '')
          .replace(/\n/g, '\\n');
        lines.push(
          `L${change.range.start.line + 1}:C${change.range.start.character}-L${change.range.end.line + 1}:C${change.range.end.character} ${type} "${text}"`
        );
      }
      sections.push(lines.join('\n'));
    }

    if (sections.length === 0) return '';

    return (
      `[CONTEXT UPDATE]\n` +
      `Apply these editor changes to cached files for future inline completions. Reply with only: OK\n\n` +
      sections.join('\n\n')
    );
  }

  private changeType(change: vscode.TextDocumentContentChangeEvent): string {
    if (change.rangeLength === 0) return 'INSERT';
    if (change.text.length === 0) return 'DELETE';
    return 'REPLACE';
  }

  private markPrimed(document: vscode.TextDocument, timestamp: number): void {
    this.primedFiles.set(document.uri.toString(), {
      uri: document.uri.fsPath,
      version: document.version,
      lineCount: document.lineCount,
      primedAt: timestamp,
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.primedFiles.clear();
    this.pendingUpdates.clear();
    this.regexCache.clear();
  }
}
