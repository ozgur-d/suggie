import * as vscode from 'vscode';
import { CliService } from '../services/cliService';
import { ContextCollector } from '../services/contextCollector';
import { ContextPrimingService } from '../services/contextPrimingService';
import { CompletionCache } from '../services/completionCache';
import { SessionState } from '../services/sessionState';
import { Debouncer } from '../utils/debouncer';
import { ModelTier, FileContext } from '../models/types';

export type StatusCallback = (loading: boolean) => void;

const TRIGGER_CHARS = new Set(['.', ';', '{', '}', '(', ')', ',', ':', ' ', '\t']);
const CACHE_BEFORE_CHARS = 400;
const CACHE_AFTER_CHARS = 200;
const LIGHT_BEFORE_LINES = 4;
const LIGHT_AFTER_LINES = 2;

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastRequestId: string | null = null;

  constructor(
    private cliService: CliService,
    private debouncer: Debouncer,
    private getModel: () => ModelTier,
    private onStatusChange: StatusCallback,
    private contextCollector?: ContextCollector,
    private sessionState?: SessionState,
    private primingService?: ContextPrimingService,
    private cache?: CompletionCache
  ) {}

  setContextCollector(collector: ContextCollector): void {
    this.contextCollector = collector;
  }

  setSessionState(state: SessionState): void {
    this.sessionState = state;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    const isManualTrigger =
      context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

    if (!isManualTrigger) {
      const lineText = document.lineAt(position.line).text;
      const charBefore = position.character > 0 ? lineText[position.character - 1] : '';
      const charAfter = position.character < lineText.length ? lineText[position.character] : '';
      const isAtBreakpoint =
        charBefore === '' ||
        TRIGGER_CHARS.has(charBefore) ||
        lineText.trimEnd().length === 0 ||
        position.character === lineText.trimEnd().length;

      if (!isAtBreakpoint && /\w/.test(charBefore) && !/\s/.test(charAfter || ' ')) {
        return [];
      }
    }

    // Build cache key once
    const cacheKey = this.buildCacheKey(document, position);

    // Cache lookup (works for both manual and auto triggers)
    if (this.cache) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        const requestId = `cache_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.lastRequestId = requestId;
        return [this.makeItem(hit, position, requestId)];
      }
    }

    if (!isManualTrigger && this.cliService.isBusy(this.getModel())) {
      return [];
    }

    const doCompletion = async (): Promise<vscode.InlineCompletionItem[]> => {
      if (token.isCancellationRequested) return [];

      this.onStatusChange(true);
      try {
        const model = this.getModel();
        const prompt = this.buildPromptForRequest(document, position, isManualTrigger);
        const rawResult = await this.cliService.spawnCompletion(prompt, model, token);
        const result = rawResult ? this.normalizeCompletion(rawResult) : null;

        if (!result || token.isCancellationRequested) return [];

        if (this.lastRequestId && this.sessionState) {
          this.sessionState.recordFeedback(this.lastRequestId, 'dismissed', '');
        }

        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.lastRequestId = requestId;

        if (this.cache) {
          this.cache.set(cacheKey, result);
        }

        return [this.makeItem(result, position, requestId)];
      } catch {
        return [];
      } finally {
        this.onStatusChange(false);
      }
    };

    if (isManualTrigger) {
      return doCompletion();
    }

    const result = await this.debouncer.trigger(doCompletion);
    return result ?? [];
  }

  private makeItem(
    text: string,
    position: vscode.Position,
    requestId?: string
  ): vscode.InlineCompletionItem {
    const acceptCommand: vscode.Command | undefined = requestId
      ? {
          command: 'suggie.acceptedCompletion',
          title: '',
          arguments: [requestId, text],
        }
      : undefined;
    return new vscode.InlineCompletionItem(
      text,
      new vscode.Range(position, position),
      acceptCommand
    );
  }

  private buildCacheKey(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    const beforeStart = document.offsetAt(position) - CACHE_BEFORE_CHARS;
    const beforeRange = new vscode.Range(
      document.positionAt(Math.max(0, beforeStart)),
      position
    );
    const afterEnd = document.offsetAt(position) + CACHE_AFTER_CHARS;
    const afterRange = new vscode.Range(
      position,
      document.positionAt(afterEnd)
    );
    const before = document.getText(beforeRange);
    const after = document.getText(afterRange);
    return this.cache
      ? this.cache.buildKey(document.uri.toString(), position.line, position.character, before, after)
      : '';
  }

  private buildPromptForRequest(
    document: vscode.TextDocument,
    position: vscode.Position,
    isManualTrigger: boolean
  ): string {
    const isPrimed = this.primingService?.isFilePrimed(document.uri.toString());
    const model = this.getModel();

    if (!isManualTrigger || (isPrimed && this.cliService.isAnyWorkerPrimed(model))) {
      return this.buildLightweightPrompt(document, position, isManualTrigger);
    }

    if (this.contextCollector) {
      const payload = this.contextCollector.collectContext(document, position);
      const feedbackSummary = this.buildFeedbackSummary();

      return this.cliService.buildPrompt(
        payload.currentFileContext,
        position.line,
        position.character,
        payload.openTabContexts,
        payload.recentEdits,
        payload.fileSwitchHistory,
        feedbackSummary
      );
    }

    const startLine = Math.max(0, position.line - 30);
    const endLine = Math.min(document.lineCount - 1, position.line + 8);
    const content = document.getText(
      new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length)
    );

    const fileContext: FileContext = {
      uri: document.uri.fsPath,
      languageId: document.languageId,
      content,
      startLine,
      endLine,
    };

    return this.cliService.buildPrompt(fileContext, position.line, position.character);
  }

  private buildLightweightPrompt(
    document: vscode.TextDocument,
    position: vscode.Position,
    isManualTrigger: boolean = false
  ): string {
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const beforeStart = Math.max(0, position.line - LIGHT_BEFORE_LINES);
    const afterEnd = Math.min(document.lineCount - 1, position.line + LIGHT_AFTER_LINES);
    const vicinity: string[] = [];

    for (let i = beforeStart; i <= afterEnd; i++) {
      const text = document.lineAt(i).text;
      if (i === position.line) {
        vicinity.push(`L${i + 1}: ${text.slice(0, position.character)}[CURSOR]${text.slice(position.character)}`);
      } else {
        vicinity.push(`L${i + 1}: ${text}`);
      }
    }

    // Auto-trigger: ultra-terse so the cached prime stays the dominant
    // prompt-cache prefix. Manual trigger keeps feedback hints.
    let prompt = `[C] ${relativePath} L${position.line + 1}:C${position.character} ${document.languageId}\n`;
    prompt += vicinity.join('\n');
    prompt += '\nInsert at [CURSOR].';

    if (isManualTrigger) {
      const feedbackSummary = this.buildFeedbackSummary();
      if (feedbackSummary) {
        prompt += `\n${feedbackSummary}`;
      }
    }
    return prompt;
  }

  private buildFeedbackSummary(): string {
    if (!this.sessionState) return '';

    const feedback = this.sessionState.getRecentFeedback();
    if (feedback.length === 0) return '';

    const accepted = feedback
      .filter((f) => f.action === 'accepted')
      .slice(-3)
      .map((f) => this.shortFeedbackText(f.insertedText));
    const rejected = feedback
      .filter((f) => f.action === 'rejected')
      .slice(-3)
      .map((f) => this.shortFeedbackText(f.insertedText));

    const parts: string[] = [];
    if (accepted.length > 0) {
      parts.push(`accepted=${accepted.join(' | ')}`);
    }
    if (rejected.length > 0) {
      parts.push(`rejected=${rejected.join(' | ')}`);
    }
    return parts.length > 0 ? `Feedback: ${parts.join('; ')}` : '';
  }

  private shortFeedbackText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  private normalizeCompletion(text: string): string {
    const trimmed = text.trim();
    if (!trimmed || trimmed === 'OK') return '';

    return text
      .replace(/^\s*```[\w-]*\r?\n/, '')
      .replace(/\r?\n```\s*$/, '')
      .replace(/\r/g, '')
      .replace(/\s+$/, '');
  }
}
