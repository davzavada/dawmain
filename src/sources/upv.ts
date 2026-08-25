import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { decodeBody, htmlToText, loadHtml } from "./shared/html";

/**
 * ÚPV — Czech Industrial Property Office decisions database (ISDV,
 * isdv.upv.gov.cz/webapp — an Oracle PL/SQL gateway app, server-rendered).
 *
 * Verified surface: browse entry `rozhodnuti.prochazet` (two-level category
 * tree), listing `rozhodnuti.SeznamRozhodnuti`, and decision text
 * `rozhodnuti.showDocP?p_id={8-char token}`. The search form's field names
 * were never established publicly, so v1 is browse-only: walk the category
 * tree and read listings; tokens (p_id) are opaque and must always be taken
 * fresh from a listing. See docs/research/eu-ip-sources.json.
 */

const SOURCE = "ÚPV (ISDV)";
/** gov.cz host first; the legacy host may sit behind different filtering. */
const BASES = ["https://isdv.upv.gov.cz/webapp", "https://isdv.upv.cz/webapp"];
const BASE = BASES[0];

export interface UpvLink {
  label: string;
  href: string;
  /** p_id when the link goes straight to a decision. */
  pId?: string;
}

/** Extract category/decision links from a prochazet/Seznam page. Pure. */
export function parseUpvLinks(html: string): UpvLink[] {
  const $ = loadHtml(html);
  const links: UpvLink[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    // Keep only links inside the decisions app.
    if (!/rozhodnuti\.(prochazet|SeznamRozhodnuti|showDocP|seznam)/i.test(href)) return;
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!label) return;
    const pId = /showDocP\?p_id=([A-Za-z0-9]{4,16})/.exec(href)?.[1];
    links.push({
      label,
      href: href.startsWith("http") ? href : `${BASE}/${href.replace(/^\.?\//, "")}`,
      pId,
    });
  });
  return links;
}

/** Detect the maintenance page. Pure. */
export function isUpvMaintenance(html: string): boolean {
  return /odst[áa]vka|technick[áa] p[ře]est[áa]vka/i.test(html) && html.length < 20_000;
}

export interface UpvBrowseResult {
  categories: UpvLink[];
  decisions: UpvLink[];
  url: string;
}

// Live finding (2026-08): isdv.upv.gov.cz does not answer connections from
// US Vercel regions (fetch failed) — likely geo-filtering. The tools stay in
// place; run the deployment in fra1 and re-check with dawmain_probe_sources.
/** Fetch with host fallback: network-level failures try the legacy host. */
async function upvFetch(pathOrUrl: string): Promise<{ response: Response; html: string }> {
  const candidates = pathOrUrl.startsWith("http")
    ? [...new Set([pathOrUrl, ...BASES.map((base) => pathOrUrl.replace(/^https:\/\/[^/]+\/webapp/, base))])]
    : BASES.map((base) => `${base}/${pathOrUrl}`);
  let lastError: unknown;
  for (const url of candidates) {
    try {
      const response = await fetchUpstream(SOURCE, url, { timeoutMs: 10_000, retry: false });
      return { response, html: await decodeBody(response) };
    } catch (error) {
      if (error instanceof SourceError && error.kind !== "UPSTREAM_UNREACHABLE") throw error;
      lastError = error;
    }
  }
  throw lastError instanceof SourceError
    ? new SourceError(
        SOURCE,
        "UPSTREAM_UNREACHABLE",
        "Neither ISDV host (isdv.upv.gov.cz, isdv.upv.cz) accepted the connection.",
        "The office appears to drop connections from cloud IPs. Verify the deployment region is fra1 (dawmain_ping) and retry; if both hosts stay dead, use https://isdv.upv.gov.cz/webapp/rozhodnuti.prochazet in a browser.",
      )
    : (lastError as Error);
}

export async function browseUpv(categoryUrl?: string): Promise<UpvBrowseResult> {
  const url = categoryUrl ?? `${BASE}/rozhodnuti.prochazet`;
  if (!BASES.some((base) => url.startsWith(base))) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "category_url must point into the ISDV webapp.",
      `Use links returned by a previous upv_browse call (they start with ${BASE}).`,
    );
  }
  const { response, html } = await upvFetch(url);
  if (!response.ok || isUpvMaintenance(html)) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `ISDV answered ${response.ok ? "a maintenance page" : `HTTP ${response.status}`}.`,
      "The database has maintenance windows and appears to reject non-EU datacenter IPs — make sure the Vercel function region is fra1 (Project Settings → Functions), then retry.",
    );
  }
  const links = parseUpvLinks(html);
  if (!links.length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "No navigable links found on the ISDV page.",
      "The app layout may differ from research — run dawmain_probe_sources (canary 'upv') with include_raw and inspect the real markup.",
    );
  }
  return {
    categories: links.filter((link) => !link.pId),
    decisions: links.filter((link) => Boolean(link.pId)),
    url,
  };
}

export async function getUpvDecision(pId: string): Promise<{ text: string; url: string }> {
  if (!/^[A-Za-z0-9]{4,16}$/.test(pId)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${pId}" is not an ISDV document token.`,
      "Pass the p_id from an upv_browse decision link. Tokens are opaque and may expire — always take them fresh.",
    );
  }
  const url = `${BASE}/rozhodnuti.showDocP?p_id=${pId}`;
  const { response, html } = await upvFetch(`rozhodnuti.showDocP?p_id=${pId}`);
  if (!response.ok || isUpvMaintenance(html)) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `ISDV answered ${response.ok ? "a maintenance page" : `HTTP ${response.status}`}.`,
      "Try again later.",
    );
  }
  const text = htmlToText(html);
  if (text.length < 200) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `Document ${pId} yielded no substantial text — the token may have expired.`,
      "Re-run upv_browse and use a fresh p_id.",
    );
  }
  return { text, url };
}
