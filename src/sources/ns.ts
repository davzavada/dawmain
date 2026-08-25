import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText, loadHtml } from "./shared/html";
import { czechToIso, isoToCzech } from "./shared/text";

/**
 * Nejvyšší soud — rozhodnuti.nsoud.cz (IBM Domino classic web).
 *
 * Search is a GET against the Domino full-text view `$$WebSearch1`; the
 * decision detail is the WebSearch/WebPrint page for a 32-hex UNID (the only
 * stable identity — spisová značka is NOT unique). No session, no JSON.
 * Hard limit: any query addresses only its first 900 documents; the true
 * count appears as "(Podmínce vyhovuje: N)". Dates: query literals are
 * DD.MM.YYYY, WebSearch detail prints "20. 5. 2026", WebPrint prints
 * MM/DD/YYYY. See docs/research/cz-sources.json.
 */

const SOURCE = "Nejvyšší soud";
const BASE = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";

/** Result anchors: a.odk linking to /WebSearch/{32-hex UNID}?openDocument. */
const UNID_HREF_RE = /\/WebSearch\/([0-9A-Fa-f]{32})\?openDocument/;
const EMPTY_MARKER = "Nebyly nalezeny žádné výsledky";
const TRUNCATED_RE = /Podmínce vyhovuje:\s*([\d\s]+)/;
const COUNT_RE = /Výsledky\s+\d+\s*-\s*\d+\s+z\s+(\d[\d\s]*)/;

export interface NsSearchInput {
  query?: string;
  caseNumber?: string;
  dateFrom?: string; // ISO
  dateTo?: string; // ISO
}

/** Build the Domino FT query string from tool inputs. Pure — unit-tested. */
export function buildNsQuery(input: NsSearchInput): string {
  const clauses: string[] = [];
  if (input.caseNumber) {
    // "23 Cdo 1234/2025" → senate + registry fields + FT phrase for the rest.
    const m = /^(\d{1,3})\s+([A-Za-zČř]+)\s+(\d+\/\d{4})$/u.exec(input.caseNumber.trim());
    if (m) {
      clauses.push(`[spzn1]=${m[1]}`, `[spzn2]=${m[2].toLowerCase()}`, `"${m[3]}"`);
    } else {
      clauses.push(`"${input.caseNumber.trim()}"`);
    }
  }
  if (input.query) {
    const sanitized = input.query.replace(/[()[\]]/g, " ").trim();
    clauses.push(`[ARozhodnutiRT]=((${sanitized}))`);
  }
  if (input.dateFrom) clauses.push(`[datum_predani_na_web]>=${isoToCzech(input.dateFrom)}`);
  if (input.dateTo) clauses.push(`[datum_predani_na_web]<=${isoToCzech(input.dateTo)}`);
  if (!clauses.length) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "NS search needs at least one criterion.",
      "Provide query (full-text), case_number, or a date range.",
    );
  }
  return clauses.join(" AND ");
}

export interface NsSearchHit {
  unid: string;
  caseNumbers: string[];
  url: string;
}

export interface NsSearchPage {
  hits: NsSearchHit[];
  /** Count reported by the banner (window-capped at 900 addressable docs). */
  total: number | null;
  /** True count when the result set exceeds the 900-document window. */
  matched: number | null;
  truncated: boolean;
  empty: boolean;
}

/** Parse a $$WebSearch1 result page. Pure — unit-tested against fixtures. */
export function parseNsSearch(html: string): NsSearchPage {
  // Banners often arrive with Czech letters as HTML entities (V&yacute;sledky)
  // — match the count markers against decoded text, the rows against raw HTML.
  const decoded = htmlToText(html);
  if (decoded.includes(EMPTY_MARKER)) {
    return { hits: [], total: 0, matched: 0, truncated: false, empty: true };
  }
  const hits: NsSearchHit[] = [];
  const $ = loadHtml(html);
  $("a.odk").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const match = UNID_HREF_RE.exec(href);
    if (!match) return;
    const unid = match[1].toUpperCase();
    // The anchor may stack several spisové značky separated by <br/>.
    const caseNumbers = htmlToText($(el).html() ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    hits.push({
      unid,
      caseNumbers,
      url: `${BASE}/WebSearch/${unid}?openDocument`,
    });
  });

  const truncatedMatch = TRUNCATED_RE.exec(decoded);
  const countMatch = COUNT_RE.exec(decoded);
  const parseNumber = (raw: string) => Number(raw.replace(/\s+/g, ""));
  const matched = truncatedMatch ? parseNumber(truncatedMatch[1]) : null;
  const total = countMatch ? parseNumber(countMatch[1]) : matched;

  if (!hits.length && total === null) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "NS result page contains neither result rows nor a count banner.",
      "The site layout may have changed — run dawmain_probe_sources (canary 'ns') with include_raw.",
    );
  }
  return { hits, total, matched, truncated: matched !== null && matched > 900, empty: false };
}

export interface NsDecision {
  unid: string;
  metadata: Record<string, string>;
  text: string;
  url: string;
}

/** Labels of the metadata table (both WebSearch and WebPrint variants). */
const META_LABELS = [
  "Soud",
  "Datum rozhodnutí",
  "Spisová značka",
  "ECLI",
  "Typ rozhodnutí",
  "Heslo",
  "Dotčené předpisy",
  "Kategorie rozhodnutí",
  "Právní věta",
  "Zveřejněno na webu",
];

/** Parse a WebSearch/WebPrint decision page. Pure — unit-tested. */
export function parseNsDecision(html: string, unid: string): NsDecision {
  const $ = loadHtml(html);
  const metadata: Record<string, string> = {};

  // Preferred: td.left-part / td.right-part rows (current markup).
  $("td.left-part").each((_, el) => {
    const label = $(el).text().replace(/:\s*$/, "").trim();
    const value = $(el).siblings("td.right-part").first().text().trim();
    if (label && value) metadata[label] = value.replace(/\s+/g, " ");
  });

  // Fallback: any table row whose first cell is a known label (legacy markup).
  if (!Object.keys(metadata).length) {
    $("tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;
      const label = $(cells[0]).text().replace(/:\s*$/, "").trim();
      if (META_LABELS.includes(label)) {
        metadata[label] = $(cells[1]).text().replace(/\s+/g, " ").trim();
      }
    });
  }

  // Body: <font face="Times New Roman"> runs between the operative opening
  // and the closing citation note.
  const fontRuns: string[] = [];
  $('font[face*="Times New Roman"]').each((_, el) => {
    fontRuns.push($(el).text());
  });
  let text = fontRuns.join("\n");
  if (!text.trim()) text = htmlToText(html);
  const start = text.search(/Nejvyšší soud (?:rozhodl|jako soud)/);
  if (start > 0) text = text.slice(start);
  const end = text.indexOf("Citace rozhodnutí");
  if (end > 0) text = text.slice(0, end);
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  if (!text && !Object.keys(metadata).length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `NS decision page for ${unid} yielded neither metadata nor text.`,
      "The document may not exist, or the layout changed — verify the UNID from a fresh ns_search.",
    );
  }

  // Normalize the decision date (WebPrint prints US MM/DD/YYYY, WebSearch Czech).
  const rawDate = metadata["Datum rozhodnutí"];
  if (rawDate) {
    // WebPrint prints US MM/DD/YYYY (slashes); WebSearch prints Czech "20. 5. 2026".
    const iso = rawDate.includes("/")
      ? (usToIso(rawDate) ?? czechToIso(rawDate))
      : (czechToIso(rawDate) ?? usToIso(rawDate));
    if (iso) metadata["Datum rozhodnutí"] = iso;
  }

  return { unid, metadata, text, url: `${BASE}/WebSearch/${unid}?openDocument` };
}

/** MM/DD/YYYY → ISO (WebPrint date quirk). */
export function usToIso(raw: string): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw);
  if (!m) return null;
  const [month, day] = [Number(m[1]), Number(m[2])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// ---------- I/O ----------

export async function searchNs(
  input: NsSearchInput,
  start: number,
  count: number,
): Promise<NsSearchPage> {
  const query = buildNsQuery(input);
  const url =
    `${BASE}/$$WebSearch1?SearchView&Query=${encodeURIComponent(query)}` +
    // SearchMax must stay large: SearchMax=1 provokes HTTP 500 upstream.
    `&SearchMax=1000&SearchOrder=4&Start=${start}&Count=${count}&pohled=1`;
  const response = await fetchUpstream(SOURCE, url, {
    headers: { referer: "https://rozhodnuti.nsoud.cz/" },
  });
  return parseNsSearch(await response.text());
}

export async function getNsDecision(unid: string): Promise<NsDecision> {
  if (!/^[0-9A-Fa-f]{32}$/.test(unid)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${unid}" is not a Domino UNID.`,
      "Pass the 32-character hexadecimal id returned by ns_search.",
    );
  }
  // WebPrint yields the cleanest HTML for extraction.
  const response = await fetchUpstream(SOURCE, `${BASE}/WebPrint/${unid}?openDocument`, {
    headers: { referer: "https://rozhodnuti.nsoud.cz/" },
  });
  return parseNsDecision(await response.text(), unid.toUpperCase());
}
