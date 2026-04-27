import { ContextPayload } from '../models/types';

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_MAX_TOKENS = 8000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function enforceContextBudget(
  payload: ContextPayload,
  maxTokens: number = DEFAULT_MAX_TOKENS
): ContextPayload {
  let remaining = maxTokens;
  const result: ContextPayload = {
    currentFileContext: payload.currentFileContext,
    openTabContexts: [],
    recentEdits: [],
    fileSwitchHistory: [],
    completionFeedback: [],
    totalTokenEstimate: 0,
  };

  // Priority 1: Current file context (always included, truncate if needed)
  const currentTokens = estimateTokens(result.currentFileContext.content);
  if (currentTokens > remaining) {
    const maxChars = remaining * CHARS_PER_TOKEN_ESTIMATE;
    result.currentFileContext = {
      ...result.currentFileContext,
      content: result.currentFileContext.content.slice(0, maxChars),
    };
    remaining = 0;
  } else {
    remaining -= currentTokens;
  }

  // Priority 2: Recent edits
  if (remaining > 0) {
    for (const edit of payload.recentEdits) {
      const tokens = estimateTokens(edit.text);
      if (tokens > remaining) break;
      result.recentEdits.push(edit);
      remaining -= tokens;
    }
  }

  // Priority 3: Open tab contexts (sorted by recency assumed)
  if (remaining > 0) {
    for (const tab of payload.openTabContexts) {
      const tokens = estimateTokens(tab.content);
      if (tokens > remaining) {
        const maxChars = remaining * CHARS_PER_TOKEN_ESTIMATE;
        result.openTabContexts.push({
          ...tab,
          content: tab.content.slice(0, maxChars),
        });
        remaining = 0;
        break;
      }
      result.openTabContexts.push(tab);
      remaining -= tokens;
    }
  }

  // Priority 4: File switch history (low token cost)
  if (remaining > 0) {
    const switchText = payload.fileSwitchHistory
      .map((s) => `${s.fromUri ?? '(start)'} -> ${s.toUri}`)
      .join('\n');
    const tokens = estimateTokens(switchText);
    if (tokens <= remaining) {
      result.fileSwitchHistory = payload.fileSwitchHistory;
      remaining -= tokens;
    }
  }

  // Priority 5: Completion feedback
  if (remaining > 0) {
    const feedbackText = payload.completionFeedback
      .map((f) => `${f.action}: ${f.insertedText.slice(0, 100)}`)
      .join('\n');
    const tokens = estimateTokens(feedbackText);
    if (tokens <= remaining) {
      result.completionFeedback = payload.completionFeedback;
      remaining -= tokens;
    }
  }

  result.totalTokenEstimate = maxTokens - remaining;
  return result;
}
