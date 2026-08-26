/**
 * Tiny module-scope TTL cache for warm serverless instances. Saves repeat
 * upstream requests for data that changes rarely (guidelines editions, act
 * metadata) and for repeated identical calls (searches, document texts) —
 * both a latency win and basic politeness toward the sources. Cold starts
 * simply miss; nothing here must be relied upon.
 */

interface Entry<T> {
  at: number;
  value: T;
}

/** Search results stay fresh enough for 5 minutes (agents re-run identical
 * queries after reading documents). */
export const SEARCH_TTL_MS = 5 * 60 * 1000;
/** Decision/act texts are immutable in practice — the TTL bounds memory,
 * not staleness. Callers holding big texts should also cap maxEntries. */
export const DOCUMENT_TTL_MS = 10 * 60 * 1000;

/** Cache key from a call's inputs. JSON drops undefined object fields, so
 * omitted and undefined criteria hash identically. */
export function memoKey(scope: string, parts: unknown): string {
  return `${scope}:${JSON.stringify(parts)}`;
}

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      // Drop the oldest entry — enough bookkeeping for a per-instance cache.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { at: Date.now(), value });
  }

  async through(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    this.set(key, value);
    return value;
  }
}
