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
  /** Loads still running, by key. Two identical calls arriving together (a
   * caselaw_search lane and the court's own *_search, parallel § reads of
   * one act) would otherwise each send the same upstream request — to
   * sources that rate-limit (NSS, justice.cz) or queue us behind a gate (NS). */
  private readonly pending = new Map<string, Promise<T>>();

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
    // Re-setting a key must not evict an unrelated entry: it frees its own
    // slot first, and moves to the end of the eviction order as fresh data.
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.maxEntries) {
      // Drop the oldest entry — enough bookkeeping for a per-instance cache.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { at: Date.now(), value });
  }

  /** Evict one entry — for a cached value that turned out to be dead. A load
   * still running for the key is forgotten too, so its value is not stored
   * when it lands and the next call loads afresh. */
  delete(key: string): void {
    this.store.delete(key);
    this.pending.delete(key);
  }

  /**
   * Cached value, or one shared load per key: concurrent callers of a key
   * that is still loading get the same promise. A rejection is never cached
   * (every waiting caller sees it; the next call loads again). The loader's
   * own bounds (timeouts, deadlines) are those of the caller that started
   * it — the loads here take no per-caller signal, so sharing is safe.
   */
  through(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const running = this.pending.get(key);
    if (running) return running;
    let promise: Promise<T> | undefined;
    const load$ = async (): Promise<T> => {
      // Yield first, so `promise` is assigned and registered as pending
      // before the loader runs — even a loader that throws synchronously.
      await undefined;
      try {
        const value = await load();
        // Stored only while this load is still the current one: a delete(key)
        // in the meantime (a value found dead) must not be undone by it.
        if (this.pending.get(key) === promise) this.set(key, value);
        return value;
      } finally {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      }
    };
    const started = load$();
    promise = started;
    this.pending.set(key, started);
    return started;
  }
}
