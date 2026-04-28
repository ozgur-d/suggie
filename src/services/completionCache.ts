interface CacheEntry {
  result: string;
  insertedAt: number;
}

const MAX_ENTRIES = 256;
const TTL_MS = 60_000;
const BEFORE_WINDOW = 200;
const AFTER_WINDOW = 100;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class CompletionCache {
  private map = new Map<string, CacheEntry>();

  buildKey(uri: string, line: number, col: number, beforeText: string, afterText: string): string {
    const before = beforeText.length > BEFORE_WINDOW ? beforeText.slice(-BEFORE_WINDOW) : beforeText;
    const after = afterText.length > AFTER_WINDOW ? afterText.slice(0, AFTER_WINDOW) : afterText;
    return `${uri}:${line}:${col}:${fnv1a(before + '\x00' + after)}`;
  }

  get(key: string): string | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.insertedAt > TTL_MS) {
      this.map.delete(key);
      return null;
    }
    // LRU bump
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.result;
  }

  set(key: string, result: string): void {
    if (!result) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { result, insertedAt: Date.now() });
    while (this.map.size > MAX_ENTRIES) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
