import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";

/**
 * rozhodnuti.justice.cz — decisions of obecné soudy (okresní, krajské,
 * vrchní), Ministry of Justice open-data REST API (documented, keyless,
 * CC BY 4.0).
 *
 * The API has NO server-side search: listings go strictly by publication
 * date (/api/opendata/{y}/{m}/{d}?page=n, 100/page, 0-indexed) and any
 * filtering happens client-side. Full texts by UUID via /api/finaldoc.
 * The SPA's internal search endpoint is unverified — the probe tool's
 * discover mode hunts for it post-deploy. See docs/research/cz-sources.json.
 */

const SOURCE = "rozhodnuti.justice.cz";
const BASE = "https://rozhodnuti.justice.cz/api";
/** Bounds for one invocation of the date-walk. */
const MAX_WINDOW_DAYS = 7;
const MAX_PAGES_PER_CALL = 30;

export interface JusticeListItem {
  uuid: string;
  jednaciCislo?: string;
  soud?: string;
  autor?: string;
  ecli?: string;
  predmetRizeni?: string;
  datumVydani?: string;
  datumZverejneni?: string;
  klicovaSlova?: string[];
  zminenaUstanoveni?: string[];
}

/** Parse one day-listing page. Pure — unit-tested. */
export function parseJusticeListing(json: unknown): { totalPages: number; items: JusticeListItem[] } {
  const data = json as { items?: Array<Record<string, unknown>>; totalPages?: number };
  if (!Array.isArray(data.items)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "justice.cz day listing is missing the 'items' array.",
      "The API shape may have changed — run dawmain_probe_sources (canary 'justice') with include_raw.",
    );
  }
  return {
    totalPages: typeof data.totalPages === "number" ? data.totalPages : 1,
    items: data.items.map((item) => {
      const str = (key: string) => (typeof item[key] === "string" ? (item[key] as string) : undefined);
      const arr = (key: string) =>
        Array.isArray(item[key]) ? (item[key] as unknown[]).map(String) : undefined;
      // The 'odkaz' field carries the finaldoc URL; the UUID is its last segment.
      const odkaz = str("odkaz") ?? "";
      const uuid = /([0-9a-f-]{36})\s*$/i.exec(odkaz)?.[1] ?? "";
      return {
        uuid,
        jednaciCislo: str("jednaciCislo"),
        soud: str("soud"),
        autor: str("autor"),
        ecli: str("ecli"),
        predmetRizeni: str("predmetRizeni"),
        datumVydani: str("datumVydani"),
        datumZverejneni: str("datumZverejneni"),
        klicovaSlova: arr("klicovaSlova"),
        zminenaUstanoveni: arr("zminenaUstanoveni"),
      };
    }),
  };
}

export interface JusticeListFilter {
  /** Case-insensitive substring of the court name ("Okresní soud v Mostě"). */
  court?: string;
  /** Case-insensitive substring over jednací číslo, předmět řízení, keywords, provisions. */
  keyword?: string;
}

/** Client-side filter (the API has none). Pure — unit-tested. */
export function filterJusticeItems(items: JusticeListItem[], filter: JusticeListFilter): JusticeListItem[] {
  const court = filter.court?.toLowerCase();
  const keyword = filter.keyword?.toLowerCase();
  return items.filter((item) => {
    if (court && !(item.soud ?? "").toLowerCase().includes(court)) return false;
    if (keyword) {
      const haystack = [
        item.jednaciCislo,
        item.predmetRizeni,
        ...(item.klicovaSlova ?? []),
        ...(item.zminenaUstanoveni ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

/** Enumerate the ISO days of [from, to]. Pure — unit-tested. */
export function enumerateDays(fromIso: string, toIso: string): string[] {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `Invalid date window ${fromIso}..${toIso}.`,
      "Provide ISO dates with date_from <= date_to.",
    );
  }
  const days: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
    if (days.length > MAX_WINDOW_DAYS) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `The window ${fromIso}..${toIso} exceeds ${MAX_WINDOW_DAYS} days.`,
        `This source lists by publication day with no server-side search — keep windows to ${MAX_WINDOW_DAYS} days and walk them sequentially.`,
      );
    }
  }
  return days;
}

async function fetchListingPage(dayIso: string, page: number): Promise<{ totalPages: number; items: JusticeListItem[] }> {
  const [year, month, day] = dayIso.split("-").map(Number);
  const response = await fetchUpstream(SOURCE, `${BASE}/opendata/${year}/${month}/${day}?page=${page}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return { totalPages: 0, items: [] }; // no decisions that day
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `justice.cz answered HTTP ${response.status} for ${dayIso}.`,
      "The server returns 429 under load — wait a moment and retry with a narrower window.",
    );
  }
  return parseJusticeListing(await response.json());
}

export interface JusticeListResult {
  items: JusticeListItem[];
  days_walked: string[];
  pages_fetched: number;
  /** True when the page budget ran out before the window was fully listed. */
  truncated: boolean;
}

export async function listJusticeDecisions(
  fromIso: string,
  toIso: string,
  filter: JusticeListFilter,
  limit: number,
): Promise<JusticeListResult> {
  const days = enumerateDays(fromIso, toIso);
  const items: JusticeListItem[] = [];
  let pagesFetched = 0;
  let truncated = false;

  outer: for (const day of days) {
    let page = 0;
    let totalPages = 1;
    while (page < totalPages) {
      if (pagesFetched >= MAX_PAGES_PER_CALL) {
        truncated = true;
        break outer;
      }
      const result = await fetchListingPage(day, page);
      pagesFetched++;
      totalPages = result.totalPages;
      items.push(...filterJusticeItems(result.items, filter));
      if (items.length >= limit) break outer;
      page++;
    }
  }

  return { items: items.slice(0, limit), days_walked: days, pages_fetched: pagesFetched, truncated };
}

// ---------- full text ----------

interface JusticeParagraph {
  texts?: Array<{ text?: string }>;
}

export interface JusticeDecision {
  uuid: string;
  text: string;
  metadata: Record<string, unknown>;
  url: string;
}

/** Parse a finaldoc response — leniently, the field types drift. Pure. */
export function parseJusticeDecision(json: unknown, uuid: string): JusticeDecision {
  const data = json as {
    verdictText?: string | null;
    justificationText?: string | null;
    header?: JusticeParagraph[] | null;
    verdict?: JusticeParagraph[] | null;
    justification?: JusticeParagraph[] | null;
    metadata?: Record<string, unknown> | null;
  };

  const joinParagraphs = (paragraphs: JusticeParagraph[] | null | undefined): string =>
    (paragraphs ?? [])
      .map((paragraph) => (paragraph.texts ?? []).map((t) => t.text ?? "").join(""))
      .filter(Boolean)
      .join("\n");

  let text = [data.verdictText, data.justificationText].filter(Boolean).join("\n\n");
  if (!text.trim()) {
    text = [joinParagraphs(data.header), joinParagraphs(data.verdict), joinParagraphs(data.justification)]
      .filter(Boolean)
      .join("\n\n");
  }
  if (!text.trim()) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `finaldoc ${uuid} contains no extractable text.`,
      "The document may be empty or the shape changed — run dawmain_probe_sources with include_raw.",
    );
  }
  return {
    uuid,
    text: text.trim(),
    metadata: data.metadata ?? {},
    url: `https://rozhodnuti.justice.cz/rozhodnuti/?id=${uuid}`,
  };
}

export async function getJusticeDecision(uuid: string): Promise<JusticeDecision> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${uuid}" is not a decision UUID.`,
      "Pass the uuid from justice_list_decisions.",
    );
  }
  const response = await fetchUpstream(SOURCE, `${BASE}/finaldoc/${uuid}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `justice.cz has no decision ${uuid}.`,
      "The uuid may be stale — re-run justice_list_decisions.",
    );
  }
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `justice.cz answered HTTP ${response.status} for finaldoc.`,
      "Retry in a moment (the server 429s under load).",
    );
  }
  return parseJusticeDecision(await response.json(), uuid);
}
