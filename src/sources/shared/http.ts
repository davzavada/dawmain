import { SourceError, asSourceError } from "./errors";

/**
 * All upstream I/O goes through here: per-request timeout, a browser-like UA
 * (several court sites reject the default undici UA), and one bounded retry
 * for transient failures. Sources add their own headers on top.
 */

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 dawmain-mcp/0.2";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface UpstreamOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** "manual" is required whenever Set-Cookie on a redirect matters (NALUS). */
  redirect?: RequestRedirect;
  /** Retry once on 429/5xx/network. Defaults to true for GET, false for POST. */
  retry?: boolean;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchUpstream(
  source: string,
  url: string,
  options: UpstreamOptions = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const retry = options.retry ?? method === "GET";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const attempt = async (): Promise<Response> =>
    fetch(url, {
      method,
      headers: { "user-agent": USER_AGENT, ...options.headers },
      body: options.body,
      redirect: options.redirect ?? "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

  let response: Response;
  try {
    response = await attempt();
  } catch (error) {
    if (!retry) throw asSourceError(source, error);
    await delay(500 + Math.random() * 1000);
    try {
      response = await attempt();
    } catch (secondError) {
      throw asSourceError(source, secondError);
    }
  }

  if (retry && (response.status === 429 || response.status >= 500)) {
    await delay(response.status === 429 ? 2000 : 500 + Math.random() * 1000);
    try {
      response = await attempt();
    } catch (error) {
      throw asSourceError(source, error);
    }
  }

  if (response.status === 429 || response.status >= 500) {
    throw new SourceError(
      source,
      "UPSTREAM_ERROR",
      `${source} answered HTTP ${response.status} even after a retry.`,
      "The service is overloaded or down. Wait a minute and try again with a narrower query.",
    );
  }

  return response;
}

/**
 * Minimal cookie jar for multi-step flows (NALUS viewstate dance, NSS
 * antiforgery handshake, EUIPO PDF download). Lives only for the duration of
 * one tool invocation unless a source deliberately caches it in module scope.
 */
export class CookieSession {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size(): number {
    return this.cookies.size;
  }
}
