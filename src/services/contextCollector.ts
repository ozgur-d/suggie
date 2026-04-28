import * as vscode from 'vscode';
import { SessionState } from './sessionState';
import { ContextPayload, FileContext } from '../models/types';
import { enforceContextBudget } from '../utils/contextBudget';

export class ContextCollector {
  constructor(
    private sessionState: SessionState,
    private getExcludePatterns: () => string[]
  ) {}

  collectContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): ContextPayload {
    const currentFileContext = this.extractCurrentFileContext(document, position);
    const openTabContexts = this.collectOpenTabContexts(document.uri);
    const recentEdits = this.sessionState.getRecentEdits();
    const fileSwitchHistory = this.sessionState.getFileSwitchHistory();
    const completionFeedback = this.sessionState.getRecentFeedback();

    const rawPayload: ContextPayload = {
      currentFileContext,
      openTabContexts,
      recentEdits,
      fileSwitchHistory,
      completionFeedback,
      totalTokenEstimate: 0,
    };

    return enforceContextBudget(rawPayload);
  }

  private extractCurrentFileContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): FileContext {
    const excludePatterns = this.getExcludePatterns();
    if (this.isExcluded(document.uri.fsPath, excludePatterns)) {
      return {
        uri: document.uri.fsPath,
        languageId: document.languageId,
        content: `// [Content excluded by security policy]`,
        startLine: position.line,
        endLine: position.line,
      };
    }

    const startLine = Math.max(0, position.line - 30);
    const endLine = Math.min(document.lineCount - 1, position.line + 8);
    const range = new vscode.Range(
      startLine,
      0,
      endLine,
      document.lineAt(endLine).text.length
    );

    return {
      uri: document.uri.fsPath,
      languageId: document.languageId,
      content: document.getText(range),
      startLine,
      endLine,
    };
  }

  private collectOpenTabContexts(currentUri: vscode.Uri): FileContext[] {
    const contexts: FileContext[] = [];
    const excludePatterns = this.getExcludePatterns();

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const tabInput = tab.input;
        if (!(tabInput instanceof vscode.TabInputText)) continue;
        const uri = tabInput.uri;

        if (uri.toString() === currentUri.toString()) continue;
        if (uri.scheme !== 'file') continue;
        if (this.isExcluded(uri.fsPath, excludePatterns)) continue;

        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri.toString()
        );
        if (!openDoc) continue;

        const lineCount = openDoc.lineCount;
        const maxLines = 15;
        const endLine = Math.min(lineCount - 1, maxLines - 1);
        const range = new vscode.Range(
          0,
          0,
          endLine,
          openDoc.lineAt(endLine).text.length
        );

        contexts.push({
          uri: uri.fsPath,
          languageId: openDoc.languageId,
          content: openDoc.getText(range),
          startLine: 0,
          endLine,
        });
      }
    }

    return contexts;
  }

  private isExcluded(filePath: string, patterns: string[]): boolean {
    const fileName = filePath.split(/[/\\]/).pop() ?? '';
    return patterns.some((pattern) => {
      const regex = new RegExp(
        '^' +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$'
      );
      return regex.test(fileName);
    });
  }
}
