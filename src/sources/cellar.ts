import { callDeadline } from "./shared/clock";
import { SourceError } from "./shared/errors";
import { fetchUpstream, type UpstreamOptions } from "./shared/http";
import { htmlToText } from "./shared/html";
import { DOCUMENT_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * Cellar — the EU Publications Office dissemination API (official, keyless).
 * One retrieval surface serves both EUR-Lex legislation and CJEU case law:
 *   GET /resource/celex/{CELEX}   GET /resource/ecli/{ECLI}
 * with Accept: application/xhtml+xml, text/html and a 3-letter (ISO 639-2/T)
 * Accept-Language. HTTP 300 = multi-part document listing sibling part URLs.
 */

export const CELLAR_BASE = "https://publications.europa.eu/resource";

// ---------- languages ----------

export interface CellarLanguage {
  /** ISO 639-1 — dossier-title language tags, what the tools print. */
  iso2: string;
  /** ISO 639-2/T — Accept-Language and the language authority URIs. */
  iso3: string;
}

/**
 * The 24 official EU languages — Cellar holds every one — with the other
 * spellings models write: the 639-2/B codes (the skill itself uses "cze",
 * "ger" for doctrine_search, and they carry over) and "cz"/"gr"/"dk", which
 * are country codes but assigned to no other language. Anything else used to
 * become English without a word, so Czech keywords were matched against
 * English titles and answered "no documents matched".
 */
const EU_LANGUAGES: ReadonlyArray<readonly string[]> = [
  ["bg", "bul"],
  ["hr", "hrv"],
  ["cs", "ces", "cze", "cz"],
  ["da", "dan", "dk"],
  ["nl", "nld", "dut"],
  ["en", "eng"],
  ["et", "est"],
  ["fi", "fin"],
  ["fr", "fra", "fre"],
  ["de", "deu", "ger"],
  ["el", "ell", "gre", "gr"],
  ["hu", "hun"],
  ["ga", "gle"],
  ["it", "ita"],
  ["lv", "lav"],
  ["lt", "lit"],
  ["mt", "mlt"],
  ["pl", "pol"],
  ["pt", "por"],
  ["ro", "ron", "rum"],
  ["sk", "slk", "slo"],
  ["sl", "slv"],
  ["es", "spa"],
  ["sv", "swe"],
];

/** Null prototype: lookups use raw user input as the key, and on a plain
 * object crafted keys ("constructor", "__proto__") would hit inherited
 * Object.prototype members instead of missing. */
const LANGUAGE_BY_CODE: Record<string, CellarLanguage> = Object.create(null);
for (const [iso2, iso3, ...aliases] of EU_LANGUAGES) {
  for (const code of [iso2, iso3, ...aliases]) LANGUAGE_BY_CODE[code] = { iso2, iso3 };
}

/** The codes an INPUT_INVALID hint offers. */
export const CELLAR_LANGUAGE_CODES = EU_LANGUAGES.map(([iso2]) => iso2).sort();

/** "cs", "CES", "cze", "cz", "cs-CZ", "en_GB" → {iso2, iso3}; null for
 * anything that is not an EU language. Pure. */
export function resolveCellarLanguage(input: string): CellarLanguage | null {
  const code = input.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_BY_CODE[code] ?? null;
}

/** resolveCellarLanguage, or INPUT_INVALID — never a silent switch to English. */
export function requireCellarLanguage(source: string, input: string): CellarLanguage {
  const language = resolveCellarLanguage(input);
  if (language) return language;
  throw new SourceError(
    source,
    "INPUT_INVALID",
    `"${input}" is not an EU language code.`,
    `Use one of ${CELLAR_LANGUAGE_CODES.join(", ")} (e.g. cs for Czech).`,
  );
}

// ---------- identifiers ----------

/** "CELEX:32016r0679 " (the form of every EUR-Lex URL and citation) →
 * "32016R0679". CELEX numbers are upper case throughout — also
 * 32016R0679R(02), 02016R0679-20160504, 62024CJ0474_RES. Pure. */
export function normalizeCelex(input: string): string {
  return input
    .trim()
    .replace(/^celex\s*:\s*/i, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

/** " ecli:eu:c:2020:559", "EU:C:2020:559" → "ECLI:EU:C:2020:559". Pure. */
export function normalizeEcli(input: string): string {
  const compact = input.replace(/\s+/g, "").toUpperCase();
  if (!compact) return "";
  return compact.startsWith("ECLI:") ? compact : `ECLI:${compact}`;
}

// ---------- the call's time budget ----------

/**
 * The MCP route runs under maxDuration = 60 s, and past it the platform kills
 * the function: the client sees a bare timeout instead of the tool's error
 * and hint. Before this budget one step could take 51.5 s alone (a 25 s GET,
 * a retry, 25 s again) and the SPARQL POST 61.5 s (30 + retry + 30), and the
 * text chain runs several steps in sequence (listing, parts, English
 * fallback, ECLI). Every Cellar request of one tool call therefore ends by a
 * shared deadline; the remaining ~10 s are for parsing and paging the HTML.
 */
export const CELLAR_CALL_BUDGET_MS = 50_000;
/** Less than this left: a request could only time out, so it is not started. */
const MIN_ATTEMPT_MS = 3_000;
/** The one retry of a transient failure is worth it only with this much left. */
const RETRY_MIN_LEFT_MS = 10_000;
/** One GET of a text or a part; the deadline cuts it shorter when need be. */
const GET_TIMEOUT_MS = 25_000;

/** The deadline of a tool call starting now (epoch ms) — and never past the
 * call's own boundary less its margin (callDeadline): counted from the
 * handler alone, a slow auth round trip plus 50 s reached the 54 s answer
 * of the registry, whose generic error then replaced Cellar's own. */
export function cellarDeadline(): number {
  return callDeadline(CELLAR_CALL_BUDGET_MS);
}

/** Whether one more request can still be started before the deadline. */
export function hasBudget(deadline: number): boolean {
  return deadline - Date.now() >= MIN_ATTEMPT_MS;
}

/** The budget ran out before `what` — said as such, not as an outage. */
export function budgetSpent(
  source: string,
  what: string,
  hint = "Cellar is answering slowly right now — try again in a minute.",
): SourceError {
  return new SourceError(
    source,
    "UPSTREAM_ERROR",
    `${source} answered too slowly: the call's time budget ran out before ${what}.`,
    hint,
  );
}

/** Cut off by a timeout signal — wrapped by fetchUpstream, or raw from a body read. */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof SourceError) {
    return error.kind === "UPSTREAM_UNREACHABLE" && /timeout|timed out/i.test(error.message);
  }
  return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** The status of a 429/5xx that fetchUpstream refused (it throws those). */
export function refusedStatus(error: unknown): number | undefined {
  if (!(error instanceof SourceError) || error.kind !== "UPSTREAM_ERROR") return undefined;
  const match = /answered HTTP (\d{3})\b/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

export interface DeadlineOptions {
  /** Epoch ms by which this request, its retry included, must be over. */
  deadline: number;
  /** Cap on one attempt; the deadline cuts it shorter. */
  timeoutMs: number;
  /** Whether a timed-out attempt gets the retry (never for SPARQL: a query
   * that ran into the timeout would only run into it again, twice the load). */
  retryOnTimeout: boolean;
  /** Which refused statuses (429/5xx) get the retry. */
  retryStatus: (status: number) => boolean;
  /** What the request was for, as the error says it — "fetching the text". */
  what: string;
  /** The hint when the budget runs out before the request can start. */
  budgetHint?: string;
  /** Statuses returned to the caller unthrown and unretried (fetchUpstream's
   * passStatus) — for an error body the caller classifies itself. */
  passStatus?: (status: number) => boolean;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetchUpstream with the attempt's timeout derived from the call's deadline
 * and the one retry done here instead of there: fetchUpstream's own retry
 * starts a second full timeout whatever time is left. The retry keeps its
 * rules — 2 s back-off after a 429, 0.5–1.5 s otherwise — but runs only
 * when enough of the budget is left for it to finish.
 */
export async function fetchWithinDeadline(
  source: string,
  url: string,
  init: Pick<UpstreamOptions, "method" | "headers" | "body">,
  options: DeadlineOptions,
): Promise<Response> {
  const attempt = () => {
    const left = options.deadline - Date.now();
    if (left < MIN_ATTEMPT_MS) throw budgetSpent(source, options.what, options.budgetHint);
    return fetchUpstream(source, url, {
      ...init,
      timeoutMs: Math.min(options.timeoutMs, left),
      retry: false,
      passStatus: options.passStatus,
    });
  };
  try {
    return await attempt();
  } catch (error) {
    const status = refusedStatus(error);
    const transient =
      error instanceof SourceError &&
      ((error.kind === "UPSTREAM_UNREACHABLE" && (options.retryOnTimeout || !isTimeoutError(error))) ||
        (status !== undefined && options.retryStatus(status)));
    const backoff = status === 429 ? 2000 : 500 + Math.random() * 1000;
    if (!transient || options.deadline - Date.now() - backoff < RETRY_MIN_LEFT_MS) throw error;
    await sleep(backoff);
    return attempt();
  }
}

// ---------- texts ----------

/** Texts are big — keep the entry count low; the TTL bounds memory, not staleness. */
const textCache = new TtlCache<string>(DOCUMENT_TTL_MS, 24);
/**
 * A 404/406 on the document itself: Cellar has no rendition in that language.
 * Remembered briefly so paging an English-fallback text does not ask for the
 * missing language again on every page. Nothing else is remembered: a
 * stub, a failed part or a 5xx/timeout may be transient, and English must not
 * stand in for an existing Czech text for long.
 */
const missCache = new TtlCache<true>(2 * 60 * 1000, 200);
/** Multi-part cap: raised well above anything seen in practice, with an
 * explicit truncation marker when a document still exceeds it. */
const PART_CAP = 20;

/** Thrown inside a cache load so a miss stays uncached (through() stores
 * whatever its load returns). */
class NoText extends Error {}

async function throughTextCache(key: string, load: () => Promise<string | null>): Promise<string | null> {
  try {
    return await textCache.through(key, async () => {
      const text = await load();
      if (!text) throw new NoText();
      return text;
    });
  } catch (error) {
    if (error instanceof NoText) return null;
    throw error;
  }
}

/** Let go of a body nobody reads, so the connection is freed now rather than at GC. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export interface CellarText {
  text: string;
  /** ISO 639-1 of the text served — "en" when the requested language had none. */
  language: string;
}

/**
 * A document's text in the requested language, else in English; null when
 * Cellar has neither. `language` takes any spelling resolveCellarLanguage
 * knows and throws INPUT_INVALID for anything else. `deadline` is the tool
 * call's (cellarDeadline()) — pass one deadline to every Cellar step of a
 * call; without it the call's budget starts here.
 */
export async function fetchCellarDocument(
  source: string,
  path: string,
  language: string,
  options: { deadline?: number } = {},
): Promise<CellarText | null> {
  const requested = requireCellarLanguage(source, language);
  const deadline = options.deadline ?? cellarDeadline();

  const get = (url: string, lang3: string, what: string, budgetHint?: string) =>
    fetchWithinDeadline(
      source,
      url,
      { headers: { accept: "application/xhtml+xml, text/html", "accept-language": lang3 } },
      { deadline, timeoutMs: GET_TIMEOUT_MS, retryOnTimeout: true, retryStatus: () => true, what, budgetHint },
    );

  const attempt = async (lang3: string, what: string, budgetHint?: string): Promise<string | null> => {
    const response = await get(`${CELLAR_BASE}${path}`, lang3, what, budgetHint);
    if (response.status === 300) {
      // Multi-part document: the body lists sibling part URLs — fetch in
      // parallel (order preserved by Promise.all) and concat. A failed part
      // fails the WHOLE retrieval: silently joining around a hole would
      // present a judgment with a missing middle as complete text.
      const listing = await response.text();
      // These URLs come out of a RESPONSE BODY — the only such fetch targets in
      // the codebase. Keep them on Cellar's own origin so a doctored listing
      // cannot make the deployment fetch (and echo back) arbitrary addresses.
      const cellarOrigin = new URL(CELLAR_BASE).origin;
      const allParts = [...listing.matchAll(/href="(http[^"]+)"/g)]
        .map((m) => m[1])
        .filter((href) => {
          try {
            return new URL(href).origin === cellarOrigin;
          } catch {
            return false;
          }
        });
      const parts = allParts.slice(0, PART_CAP);
      if (!parts.length) return null;
      const texts = await Promise.all(
        parts.map(async (part) => {
          const partResponse = await get(part, lang3, "fetching every part of the multi-part document");
          if (!partResponse.ok) {
            await discard(partResponse);
            return null;
          }
          return htmlToText(await partResponse.text());
        }),
      );
      if (texts.some((text) => text === null)) return null;
      const joined = texts.filter(Boolean).join("\n\n");
      if (!joined) return null;
      return allParts.length > PART_CAP
        ? `${joined}\n\n[Document truncated: only the first ${PART_CAP} of ${allParts.length} parts were retrieved.]`
        : joined;
    }
    if (!response.ok) {
      await discard(response);
      if (response.status === 404 || response.status === 406) {
        missCache.set(memoKey("cellar-miss", [path, lang3]), true);
      }
      return null;
    }
    const text = htmlToText(await response.text());
    return text.length > 200 ? text : null;
  };

  const textIn = async (lang3: string, what: string, budgetHint?: string): Promise<string | null> => {
    const key = memoKey("cellar", [path, lang3]);
    const cached = textCache.get(key);
    if (cached !== undefined) return cached;
    if (missCache.get(memoKey("cellar-miss", [path, lang3]))) return null;
    return throughTextCache(key, () => attempt(lang3, what, budgetHint));
  };

  const primary = await textIn(requested.iso3, "fetching the text");
  if (primary) return { text: primary, language: requested.iso2 };
  if (requested.iso3 === "eng") return null;

  // English fallback: cached under the language that actually served it, so a
  // transient failure of e.g. the cs rendition does not pin English text to
  // the cs key for the whole TTL — and read from there first: it used to be
  // written only, so every page of a fallback text downloaded and parsed the
  // whole English document again (and every part of a multi-part one).
  const fallback = await textIn(
    "eng",
    `fetching the English fallback (Cellar has no ${requested.iso2} text)`,
    "Call again with language: 'en' — that fetches the English text directly.",
  );
  return fallback ? { text: fallback, language: "en" } : null;
}

/** fetchCellarDocument's text alone. */
export async function fetchCellarText(
  source: string,
  path: string,
  language: string,
  options: { deadline?: number } = {},
): Promise<string | null> {
  return (await fetchCellarDocument(source, path, language, options))?.text ?? null;
}
