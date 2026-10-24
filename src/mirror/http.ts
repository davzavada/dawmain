import { fetchUpstream, type UpstreamOptions } from "@/src/sources/shared/http";

/**
 * Upstream access of the crawler: fetchUpstream (timeout, UA, one retry on
 * 5xx / network) behind a per-source pacer — one request start per interval
 * (v1-plan: 1 req/s per source). A 429 or 403 is not retried: it stops the
 * whole source (SourceStopped), the run records why, and a human looks.
 */

export class Pacer {
  private next = 0;

  constructor(private readonly intervalMs: number) {}

  /** Resolve when the next request may start. */
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

/** The source refused us (429/403): stop it, do not try the next document. */
export class SourceStopped extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} from ${url} — source stopped`);
    this.name = "SourceStopped";
  }
}

export async function pacedFetch(label: string, pacer: Pacer, url: string, options: UpstreamOptions = {}): Promise<Response> {
  await pacer.wait();
  const response = await fetchUpstream(label, url, { ...options, passStatus: (s) => s === 429 });
  if (response.status === 429 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceStopped(response.status, url);
  }
  return response;
}
