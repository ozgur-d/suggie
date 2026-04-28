export type ModelTier = "haiku" | "sonnet" | "opus";

export type TriggerKind = "automatic" | "invoke";

export type RequestStatus =
  | "pending"
  | "in_flight"
  | "completed"
  | "cancelled"
  | "failed";

export type FeedbackAction = "accepted" | "rejected" | "dismissed";

export interface FileContext {
  uri: string;
  languageId: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface EditEntry {
  uri: string;
  timestamp: number;
  startLine: number;
  endLine: number;
  text: string;
  rangeLength: number;
}

export interface FileSwitchEntry {
  fromUri: string | null;
  toUri: string;
  timestamp: number;
}

export interface FeedbackEntry {
  requestId: string;
  action: FeedbackAction;
  insertedText: string;
  timestamp: number;
}

export interface ContextPayload {
  currentFileContext: FileContext;
  openTabContexts: FileContext[];
  recentEdits: EditEntry[];
  fileSwitchHistory: FileSwitchEntry[];
  completionFeedback: FeedbackEntry[];
  totalTokenEstimate: number;
}

export interface ModelConfig {
  model: ModelTier;
  debounceMs: number;
  timeoutMs: number;
}

export const MODEL_CONFIGS: Record<ModelTier, Omit<ModelConfig, "model">> = {
  haiku: { debounceMs: 300, timeoutMs: 15000 },
  sonnet: { debounceMs: 400, timeoutMs: 30000 },
  opus: { debounceMs: 500, timeoutMs: 60000 },
};
