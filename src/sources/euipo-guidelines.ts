import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";

/**
 * EUIPO Examination Guidelines — guidelines.euipo.europa.eu.
 *
 * Live finding (2026-08): the site is a client-rendered React SPA (SDL/RWS
 * Dita Delivery) — its HTML is an empty shell, the content lives in the
 * delivery webapp's JSON API:
 *   GET /api/publications                     all editions (Id, Title, …)
 *   GET /api/toc/{publicationId}              root TOC items
 *   GET /api/toc/{publicationId}/{sitemapId}  children of one item
 *   GET /api/page/{publicationId}/{pageId}    one section (HTML inside JSON)
 * Editions change yearly; ids are env-overridable, otherwise the newest
 * matching publication is picked at runtime.
 */

const SOURCE = "EUIPO Guidelines";
const BASE = "https://guidelines.euipo.europa.eu";

/** Fallback edition ids (2026 EN TM / EN designs) when the API listing fails. */
const FALLBACK_PUBLICATIONS: Record<string, string> = {
  trademark: "2319054",
  design: "2231430",
};

const TITLE_PATTERNS: Record<string, RegExp> = {
  trademark: /trade\s*mark/i,
  design: /design/i,
};

function envPublication(register: "trademark" | "design"): string | undefined {
  const env =
    register === "trademark"
      ? process.env.EUIPO_GUIDELINES_TM_PUB
      : process.env.EUIPO_GUIDELINES_DESIGN_PUB;
  return env?.trim() || undefined;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetchUpstream(SOURCE, `${BASE}${path}`, {
    headers: { accept: "application/json" },
    timeoutMs: 20_000,
  });
  if (response.status === 404) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `Guidelines API has nothing at ${path}.`,
      "Check the ids via euipo_guidelines_toc.",
    );
  }
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `Guidelines API answered HTTP ${response.status} for ${path}.`,
      "Retry in a moment; if it persists, run dawmain_probe_sources (canary 'euipo-guidelines').",
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `Guidelines API returned ${contentType || "no content-type"} instead of JSON for ${path}.`,
      "The delivery API may have moved — capture the response via dawmain_probe_sources include_raw.",
    );
  }
  return response.json();
}

const str = (record: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

// ---------- publications ----------

export interface GuidelinesPublication {
  id: string;
  title: string;
}

/** Parse /api/publications (tolerant to Id/id casing). Pure — unit-tested. */
export function parsePublications(json: unknown): GuidelinesPublication[] {
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { items?: unknown[] })?.items)
      ? (json as { items: unknown[] }).items
      : null;
  if (!list) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Guidelines /api/publications is not a list.",
      "Capture the shape via dawmain_probe_sources include_raw and update parsePublications.",
    );
  }
  return list
    .map((item) => {
      const record = item as Record<string, unknown>;
      return {
        id: str(record, "Id", "id") ?? "",
        title: str(record, "Title", "title") ?? "",
      };
    })
    .filter((publication) => publication.id);
}

/** Newest publication whose title matches the register (ids grow over time). */
export function pickPublication(
  publications: GuidelinesPublication[],
  register: "trademark" | "design",
): GuidelinesPublication | undefined {
  return publications
    .filter((publication) => TITLE_PATTERNS[register].test(publication.title))
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
}

// ---------- TOC ----------

export interface GuidelinesTopic {
  topicId: string;
  title: string;
  hasChildren: boolean;
  url: string;
}

/** Parse a /api/toc response. Pure — unit-tested. */
export function parseToc(json: unknown, publicationId: string): GuidelinesTopic[] {
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { items?: unknown[] })?.items)
      ? (json as { items: unknown[] }).items
      : null;
  if (!list) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Guidelines TOC response is not a list.",
      "Capture the shape via dawmain_probe_sources include_raw and update parseToc.",
    );
  }
  return list
    .map((item) => {
      const record = item as Record<string, unknown>;
      // Url looks like "/{pub}/{topic}/{slug}…" — the topic id is segment 2.
      const url = str(record, "Url", "url") ?? "";
      const fromUrl = new RegExp(`^/${publicationId}/(\\d+)`).exec(url)?.[1];
      const id = fromUrl ?? str(record, "Id", "id") ?? "";
      const hasChildren = Boolean(
        (record.HasChildNodes ?? record.hasChildNodes ?? record.HasChildren) === true,
      );
      return {
        topicId: id,
        title: str(record, "Title", "title") ?? "",
        hasChildren,
        url: `${BASE}/${publicationId}/${id}`,
      };
    })
    .filter((topic) => topic.topicId);
}

// ---------- section ----------

/** Pull the HTML/text payload out of a /api/page JSON. Pure — unit-tested. */
export function parsePage(json: unknown): string {
  const record = json as Record<string, unknown>;
  // The delivery API nests the content — take the longest HTML-looking string.
  let best = "";
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (value.length > best.length && /<\w+[^>]*>/.test(value)) best = value;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) visit(nested, depth + 1);
    }
  };
  visit(record, 0);
  if (!best) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Guidelines page JSON carries no HTML content.",
      "Capture the shape via dawmain_probe_sources include_raw and update parsePage.",
    );
  }
  return htmlToText(best);
}

// ---------- I/O ----------

export async function fetchGuidelinesToc(
  register: "trademark" | "design",
  parentTopicId?: string,
): Promise<{ publicationId: string; publicationTitle?: string; topics: GuidelinesTopic[] }> {
  let publicationId = envPublication(register);
  let publicationTitle: string | undefined;

  if (!publicationId) {
    try {
      const publications = parsePublications(await fetchJson("/api/publications"));
      const picked = pickPublication(publications, register);
      if (picked) {
        publicationId = picked.id;
        publicationTitle = picked.title;
      }
    } catch {
      // Listing unavailable — fall through to the pinned fallback edition.
    }
    publicationId ??= FALLBACK_PUBLICATIONS[register];
  }

  const path = parentTopicId
    ? `/api/toc/${publicationId}/${parentTopicId}`
    : `/api/toc/${publicationId}`;
  const topics = parseToc(await fetchJson(path), publicationId);
  if (!topics.length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `Guidelines TOC for publication ${publicationId} came back empty.`,
      "The edition id may be stale — set EUIPO_GUIDELINES_TM_PUB / _DESIGN_PUB, or capture /api/toc via probe include_raw.",
    );
  }
  return { publicationId, publicationTitle, topics };
}

export async function fetchGuidelinesSection(
  publicationId: string,
  topicId: string,
): Promise<{ text: string; url: string }> {
  const text = parsePage(await fetchJson(`/api/page/${publicationId}/${topicId}`));
  return { text, url: `${BASE}/${publicationId}/${topicId}` };
}
