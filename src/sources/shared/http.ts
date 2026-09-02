import { SourceError, asSourceError } from "./errors";
import { recordSourceResult } from "./health";

/**
 * All upstream I/O goes through here: per-request timeout, a browser-like UA
 * (several court sites reject the default undici UA), and one bounded retry
 * for transient failures. Sources add their own headers on top.
 */

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 dawmain-mcp/0.2";

const DEFAULT_TIMEOUT_MS = 15_000;
/** Nothing legitimate here is bigger; a runaway body would exhaust the heap. */
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

export interface UpstreamOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** "manual" is required whenever Set-Cookie on a redirect matters (NALUS). */
  redirect?: RequestRedirect;
  /** Retry once on 429/5xx/network. Defaults to true for GET, false for POST. */
  retry?: boolean;
  /** Reject bodies larger than this (default 12 MB). */
  maxBytes?: number;
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
    if (!retry) {
      recordSourceResult(source, false, errorLabel(error));
      throw asSourceError(source, error);
    }
    await delay(500 + Math.random() * 1000);
    try {
      response = await attempt();
    } catch (secondError) {
      recordSourceResult(source, false, errorLabel(secondError));
      throw asSourceError(source, secondError);
    }
  }

  if (retry && (response.status === 429 || response.status >= 500)) {
    await delay(response.status === 429 ? 2000 : 500 + Math.random() * 1000);
    try {
      response = await attempt();
    } catch (error) {
      recordSourceResult(source, false, errorLabel(error));
      throw asSourceError(source, error);
    }
  }

  if (response.status === 429 || response.status >= 500) {
    recordSourceResult(source, false, `HTTP ${response.status}`);
    throw new SourceError(
      source,
      "UPSTREAM_ERROR",
      `${source} answered HTTP ${response.status}${retry ? " even after a retry" : ""}.`,
      "The service is overloaded or down. Wait a minute and try again with a narrower query.",
    );
  }

  // Refuse oversized bodies BEFORE any caller reads them into memory: every
  // reader here (.text(), .arrayBuffer(), PDF extraction) is unbounded, so one
  // runaway response would exhaust the function's heap.
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // The source answered - this is our own size guard, not an outage.
    recordSourceResult(source, true);
    throw new SourceError(
      source,
      "UPSTREAM_ERROR",
      `${source} returned ${Math.round(declared / 1024 / 1024)} MB, over the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      "Narrow the request - this server does not download whole datasets.",
    );
  }

  recordSourceResult(source, response.ok, response.ok ? undefined : `HTTP ${response.status}`);
  return response;
}

/**
 * Read a body while counting: the content-length guard above cannot see a
 * chunked response, so a reader that follows arbitrary links needs the cap
 * on the bytes themselves. Throws once `maxBytes` is exceeded.
 */
export async function readBodyCapped(source: string, response: Response, maxBytes = DEFAULT_MAX_BYTES): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceError(
        source,
        "UPSTREAM_ERROR",
        `${source}: the response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
        "Narrow the request - this server does not download whole datasets.",
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Short, log-safe label for what went wrong - an error name, not its text. */
function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timeout" : error.name;
  return "chyba spojení";
}

/**
 * Minimal cookie jar for multi-step flows (NALUS viewstate dance, NSS
 * antiforgery handshake). Lives only for the duration of
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
