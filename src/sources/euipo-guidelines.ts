import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText, loadHtml } from "./shared/html";

/**
 * EUIPO Examination Guidelines — guidelines.euipo.europa.eu (SDL LiveContent).
 *
 * URL scheme: /{publicationId}/{topicId}[/{slug}/{slug}] — the numeric ids are
 * canonical, slugs decorative. Each language+edition is a separate
 * publicationId, and editions change yearly, so the ids are env-overridable;
 * the defaults are the editions verified in research (2026 EN trade marks,
 * 2025 EN designs). The on-site search endpoint is not public — this client
 * only walks the TOC and fetches sections. See docs/research/eu-ip-sources.json.
 */

const SOURCE = "EUIPO Guidelines";
const BASE = "https://guidelines.euipo.europa.eu";

/** Editions verified in research; override via env when a new one lands. */
const DEFAULT_PUBLICATIONS: Record<string, string> = {
  trademark: "2319054", // 2026 EN TM edition, in force since 01/07/2026
  design: "2231430", // designs EN edition
};

export function getPublicationId(register: "trademark" | "design"): string {
  const env =
    register === "trademark"
      ? process.env.EUIPO_GUIDELINES_TM_PUB
      : process.env.EUIPO_GUIDELINES_DESIGN_PUB;
  return env?.trim() || DEFAULT_PUBLICATIONS[register];
}

export interface GuidelinesTopic {
  topicId: string;
  title: string;
  url: string;
}

/** Extract topic links of one publication from its root/TOC page. Pure. */
export function parseGuidelinesToc(html: string, publicationId: string): GuidelinesTopic[] {
  const $ = loadHtml(html);
  const seen = new Map<string, GuidelinesTopic>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    // Absolute or relative links into the same publication: /{pub}/{topic}/…
    const match = new RegExp(`(?:^|${BASE})/${publicationId}/(\\d+)(?:/|$)`).exec(href);
    if (!match) return;
    const topicId = match[1];
    const title = $(el).text().replace(/\s+/g, " ").trim();
    if (!title) return;
    if (!seen.has(topicId)) {
      seen.set(topicId, { topicId, title, url: `${BASE}/${publicationId}/${topicId}` });
    }
  });
  return [...seen.values()];
}

/** Extract the main content of a section page. Pure. */
export function parseGuidelinesSection(html: string): string {
  const $ = loadHtml(html);
  $("script, style, noscript, nav, header, footer").remove();
  // Prefer semantic containers; fall back to the whole body.
  for (const selector of ["main", "article", "[role='main']", "#content", ".content"]) {
    const node = $(selector).first();
    if (node.length) {
      const text = htmlToText(node.html() ?? "");
      if (text.length > 200) return text;
    }
  }
  return htmlToText($("body").html() ?? html);
}

export async function fetchGuidelinesToc(register: "trademark" | "design"): Promise<{
  publicationId: string;
  topics: GuidelinesTopic[];
}> {
  const publicationId = getPublicationId(register);
  const response = await fetchUpstream(SOURCE, `${BASE}/${publicationId}`, { timeoutMs: 20_000 });
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `Guidelines publication ${publicationId} answered HTTP ${response.status}.`,
      `The edition id may be outdated (a new edition gets a new id). Set env ${register === "trademark" ? "EUIPO_GUIDELINES_TM_PUB" : "EUIPO_GUIDELINES_DESIGN_PUB"} to the current publication id from https://guidelines.euipo.europa.eu/.`,
    );
  }
  const topics = parseGuidelinesToc(await response.text(), publicationId);
  if (!topics.length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `No topic links found on the TOC of publication ${publicationId}.`,
      "The page may be client-rendered after all — run dawmain_probe_sources (canary 'euipo-guidelines') with include_raw and inspect.",
    );
  }
  return { publicationId, topics };
}

export async function fetchGuidelinesSection(
  publicationId: string,
  topicId: string,
): Promise<{ text: string; url: string }> {
  const url = `${BASE}/${publicationId}/${topicId}`;
  const response = await fetchUpstream(SOURCE, url, { timeoutMs: 20_000 });
  if (response.status === 404) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `No guidelines section at ${publicationId}/${topicId}.`,
      "Get valid topic ids from euipo_guidelines_toc.",
    );
  }
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `Guidelines answered HTTP ${response.status}.`,
      "Retry in a moment.",
    );
  }
  const text = parseGuidelinesSection(await response.text());
  if (text.length < 100) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `Section ${publicationId}/${topicId} yielded almost no text.`,
      "The content may be client-rendered — run dawmain_probe_sources with include_raw to inspect the page.",
    );
  }
  return { text, url };
}
