/**
 * Tiny module-scope TTL cache for warm serverless instances. Saves repeat
 * upstream requests for data that changes rarely (guidelines editions, act
 * metadata) — both a latency win and basic politeness toward the sources.
 * Cold starts simply miss; nothing here must be relied upon.
 */

interface Entry<T> {
  at: number;
  value: T;
}

const MAX_ENTRIES = 200;

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs: number) {}

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
    if (this.store.size >= MAX_ENTRIES) {
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
