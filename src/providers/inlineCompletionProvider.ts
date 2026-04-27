import * as vscode from 'vscode';
import { CliService } from '../services/cliService';
import { ContextCollector } from '../services/contextCollector';
import { ContextPrimingService } from '../services/contextPrimingService';
import { SessionState } from '../services/sessionState';
import { Debouncer } from '../utils/debouncer';
import { ModelTier, MODEL_CONFIGS, FileContext, EditEntry, FileSwitchEntry } from '../models/types';

export type StatusCallback = (loading: boolean) => void;

const TRIGGER_CHARS = new Set(['.', ';', '{', '}', '(', ')', ',', ':', ' ', '\t']);

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastRequestId: string | null = null;
  private lastResultCache: { uri: string; line: number; hash: string; items: vscode.InlineCompletionItem[] } | null = null;

  constructor(
    private cliService: CliService,
    private debouncer: Debouncer,
    private getModel: () => ModelTier,
    private onStatusChange: StatusCallback,
    private contextCollector?: ContextCollector,
    private sessionState?: SessionState,
    private primingService?: ContextPrimingService
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

    // Smart trigger: skip mid-word for automatic triggers
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

      // Dedup guard: return cached result if same position and content
      const contentHash = document.getText(
        new vscode.Range(
          Math.max(0, position.line - 3), 0,
          Math.min(document.lineCount - 1, position.line + 1),
          document.lineAt(Math.min(document.lineCount - 1, position.line + 1)).text.length
        )
      );
      const hash = `${contentHash.length}:${contentHash.slice(-200)}`;
      if (
        this.lastResultCache &&
        this.lastResultCache.uri === document.uri.toString() &&
        this.lastResultCache.line === position.line &&
        this.lastResultCache.hash === hash
      ) {
        return this.lastResultCache.items;
      }
    }

    const doCompletion = async (): Promise<vscode.InlineCompletionItem[]> => {
      if (token.isCancellationRequested) {
        return [];
      }

      this.onStatusChange(true);
      try {
        const model = this.getModel();
        const prompt = this.buildPromptForRequest(document, position);
        const result = await this.cliService.spawnCompletion(prompt, model, token);

        if (!result || token.isCancellationRequested) {
          return [];
        }

        // Mark previous suggestion as dismissed only when a new one replaces it
        if (this.lastRequestId && this.sessionState) {
          this.sessionState.recordFeedback(this.lastRequestId, 'dismissed', '');
        }

        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.lastRequestId = requestId;

        const acceptCommand: vscode.Command = {
          command: 'suggie.acceptedCompletion',
          title: '',
          arguments: [requestId, result],
        };

        const item = new vscode.InlineCompletionItem(
          result,
          new vscode.Range(position, position),
          acceptCommand
        );

        const items = [item];
        const contentHash = document.getText(
          new vscode.Range(
            Math.max(0, position.line - 3), 0,
            Math.min(document.lineCount - 1, position.line + 1),
            document.lineAt(Math.min(document.lineCount - 1, position.line + 1)).text.length
          )
        );
        this.lastResultCache = {
          uri: document.uri.toString(),
          line: position.line,
          hash: `${contentHash.length}:${contentHash.slice(-200)}`,
          items,
        };

        return items;
      } catch {
        return [];
      } finally {
        this.onStatusChange(false);
      }
    };

    if (isManualTrigger) {
      return doCompletion();
    }

    // Automatic trigger — debounce
    const result = await this.debouncer.trigger(doCompletion);
    return result ?? [];
  }

  private buildPromptForRequest(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    const isPrimed = this.primingService?.isFilePrimed(document.uri.toString());

    if (isPrimed) {
      return this.buildLightweightPrompt(document, position);
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

    const startLine = Math.max(0, position.line - 80);
    const endLine = Math.min(document.lineCount - 1, position.line + 10);
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
    position: vscode.Position
  ): string {
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const beforeStart = Math.max(0, position.line - 15);
    const afterEnd = Math.min(document.lineCount - 1, position.line + 5);

    const linesBefore = [];
    for (let i = beforeStart; i < position.line; i++) {
      linesBefore.push(document.lineAt(i).text);
    }

    const linesAfter = [];
    for (let i = position.line; i <= afterEnd; i++) {
      linesAfter.push(document.lineAt(i).text);
    }

    const currentLineText = document.lineAt(position.line).text;
    const feedbackSummary = this.buildFeedbackSummary();

    let prompt = `[COMPLETE] ${relativePath} L${position.line}:C${position.character} (${document.languageId})\n`;
    prompt += `You already have the full content of this file from a previous CONTEXT PRIME message.\n\n`;
    prompt += `--- Cursor vicinity ---\n`;
    prompt += linesBefore.join('\n');
    prompt += '\n[CURSOR]\n';
    prompt += linesAfter.join('\n');
    prompt += `\n--- End ---\n`;
    prompt += `Current line: "${currentLineText}"\n`;

    if (feedbackSummary) {
      prompt += `\n${feedbackSummary}\n`;
    }

    prompt += '\nInsert code at [CURSOR].';
    return prompt;
  }

  private buildFeedbackSummary(): string {
    if (!this.sessionState) return '';

    const feedback = this.sessionState.getRecentFeedback();
    if (feedback.length === 0) return '';

    const accepted = feedback
      .filter((f) => f.action === 'accepted')
      .map((f) => f.insertedText.slice(0, 80));
    const rejected = feedback
      .filter((f) => f.action === 'rejected')
      .map((f) => f.insertedText.slice(0, 80));

    const parts: string[] = [];
    if (accepted.length > 0) {
      parts.push(`Accepted patterns:\n${accepted.join('\n')}`);
    }
    if (rejected.length > 0) {
      parts.push(`Rejected patterns:\n${rejected.join('\n')}`);
    }
    return parts.join('\n\n');
  }
}
