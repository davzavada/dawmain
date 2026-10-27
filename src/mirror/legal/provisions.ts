import { ACT_ABBREVIATIONS, ACT_NUMBER_RE, zakId } from "@/src/files/index/acts";
import { EU_ACT_RE, euActId } from "@/src/files/index/identifiers";

/**
 * The provisions a decision cites — § and články, down to odstavec,
 * písmeno and bod — each with the act it belongs to (decided 26. 10.:
 * finer than §, every act, no time versions). DERIVED from the text
 * (decision_provision, rebuilt by `mirror reindex`).
 *
 * 1. Act mentions, with their spans: by number (Sbírka zákonů, Sbírka
 *    mezinárodních smluv, EU acts by number), by name (the registry's
 *    "zákon o …" names: only the first word declines), by the act table's
 *    names and abbreviations (src/files/index/acts.ts), by the sources
 *    cited by name (Ústava, Listina, Úmluva, SFEU, SEU, Listina EU), and by
 *    the caller's global aliases (mined from the case law).
 * 2. Definitions inside the decision — "zákona č. 99/1963 Sb., občanský
 *    soudní řád, ve znění pozdějších předpisů (dále jen „o. s. ř.“)" — bind
 *    the alias to the MAIN act of the clause (not an amendment after "ve
 *    znění"); every later occurrence of the alias is a mention of it. A
 *    definition beats every global meaning, so "(dále jen „zákon“)" makes
 *    "zákon" that one act in this decision only.
 * 3. Provision references: "§", "§§", "čl.", "článek/článku/…", each a list
 *    ("§ 2910 a 2913", "§§ 2910 až 2913" — a range of up to 30 expands),
 *    each with odstavce, písmena and body ("odst. 1 a 2", "písm. a) až c)").
 * 4. Each reference takes the act mentioned right after it, else the act a
 *    back-reference names ("téhož zákona", "citovaného nařízení", "tohoto
 *    zákona") — the last act mentioned before it — else none ('').
 *
 * Provision keys: par:2913, par:2913/o1, par:2913/o1/pb, par:2913/o1/pb/b3,
 * par:243c/o3/v1 (věta první; vposl, vpred / vza = před / za středníkem);
 * cl:6/o1/pf; a písmeno without odstavec: par:2913/pb. Every level is
 * emitted, so a search for § 2913 finds a decision citing only písm. b).
 * Offsets are JavaScript string indices into the text. Pure — unit-tested.
 */

export interface ActMention {
  start: number;
  end: number;
  act: string;
}

export interface ProvisionMention {
  /** Act id, or "" when it could not be resolved. */
  act: string;
  /** Deepest key of the reference ("par:2913/o1/pb"); `keys` holds every level. */
  provision: string;
  keys: string[];
  start: number;
  end: number;
}

/** What the registry adds: names ("zákon o …" subjects) and global aliases, both resolved with the decision's year. */
export interface ActLookup {
  /** "zákon" + subject words ("obchodních korporacích…") → the act whose name the words start with. */
  byName(kind: string, words: string, year: number | null): { act: string; length: number } | null;
  /** Global aliases (mined abbreviations) as [alias, act] — never generic words. */
  aliases(year: number | null): Array<[string, string]>;
}

const ODD_SPACES = /[     ]/g;
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

/** Acts cited by name only — the act table (acts.ts) has Ústava; these it lacks. Longest match wins. */
const NAMED_SOURCES: Array<{ pattern: RegExp; act: string }> = [
  { pattern: new RegExp(`${B}Listin\\p{L}*\\s+základních\\s+práv\\s+Evropské\\s+unie${E}`, "gu"), act: "eu:12016P/TXT" },
  { pattern: new RegExp(`${B}Listin\\p{L}*\\s+EU${E}`, "gu"), act: "eu:12016P/TXT" },
  { pattern: new RegExp(`${B}Listin\\p{L}*(?:\\s+základních\\s+práv\\s+a\\s+svobod)?${E}`, "gu"), act: "zak:2/1993" },
  { pattern: new RegExp(`${B}Úmluv\\p{L}*\\s+o\\s+ochraně\\s+lidských\\s+práv\\s+a\\s+základních\\s+svobod${E}`, "gu"), act: "zak:209/1992" },
  { pattern: new RegExp(`${B}Úmluv\\p{L}*${E}(?!\\s+(?:o|OSN|č\\.)\\s)`, "gu"), act: "zak:209/1992" },
  { pattern: new RegExp(`${B}(?:SFEU|Smlouv\\p{L}*\\s+o\\s+fungování\\s+(?:Evropské\\s+unie|EU))${E}`, "gu"), act: "eu:12016E/TXT" },
  { pattern: new RegExp(`${B}(?:SEU|Smlouv\\p{L}*\\s+o\\s+Evropské\\s+unii)${E}`, "gu"), act: "eu:12016M/TXT" },
];

/**
 * Abbreviations whose act changed with a recodification: in a decision
 * before the new code's effect, "obč. zák." is the 1964 code (case law,
 * 26. 10.: 169 definitions of it for 40/1964, 22 for 89/2012), "tr. zák."
 * the 1961 one. The decision's year decides; without one, the table's act stays.
 */
const RECODIFIED: Array<{ text: RegExp; act: string; until: number; old: string }> = [
  { text: /^(?:obč\.\s?zák|ObčZ|občansk\p{L}+\s+zákoník)/iu, act: "zak:89/2012", until: 2014, old: "zak:40/1964" },
  { text: /^(?:tr\.\s?zák|TrZ|trestní(?:ho|m)?\s+zákon(?!\p{L}))/iu, act: "zak:40/2009", until: 2010, old: "zak:140/1961" },
  { text: /^(?:obch\.\s?zák|ObchZ)/iu, act: "zak:513/1991", until: 9999, old: "zak:513/1991" },
];

function recodified(act: string, matched: string, year: number | null): string {
  if (year === null) return act;
  for (const r of RECODIFIED) if (r.act === act && year < r.until && r.text.test(matched)) return r.old;
  return act;
}

/** "zákon(a|u|em…) o", "vyhlášky … o", "nařízení vlády … o" — the start of a name the registry may know. */
const NAME_HEAD = /(?<![\p{L}])(ústavní(?:ho|m)?\s+zákon\p{L}*|zákon\p{L}*|vyhlášk\p{L}*|vyhláš\p{L}*|nařízení\s+vlády)\s+o\s+/giu;

/** "Sb. m. s." treaties: "č. 12/2005 Sb. m. s." */
const SMS_RE = /(?<![\p{L}\p{N}/])(\d{1,4})\s*\/\s*(\d{4})\s*Sb\.\s*m\.\s*s\./gu;

function escapeAlias(alias: string): string {
  return alias
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\.\s*/g, "\\.\\s?")
    .replace(/\s+/g, "\\s+");
}

/** Every act mention of `t` (normalized spaces), longest first on a tie of start. */
export function findActMentions(t: string, lookup: ActLookup | null, year: number | null): ActMention[] {
  const out: ActMention[] = [];
  for (const m of t.matchAll(ACT_NUMBER_RE)) {
    const [n, y] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    out.push({ start: m.index, end: m.index + m[0].length, act: zakId(n, y) });
  }
  for (const m of t.matchAll(SMS_RE)) out.push({ start: m.index, end: m.index + m[0].length, act: `sm:${Number(m[1])}/${m[2]}` });
  for (const m of t.matchAll(EU_ACT_RE)) {
    const id = m[3] !== undefined ? euActId(m[1], m[3], m[4]) : euActId(m[1], m[5], m[6]);
    if (id) out.push({ start: m.index, end: m.index + m[0].length, act: id });
  }
  for (const entry of ACT_ABBREVIATIONS) {
    const re = new RegExp(entry.pattern.source, entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`);
    for (const m of t.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, act: recodified(entry.act, m[0], year) });
  }
  for (const { pattern, act } of NAMED_SOURCES) {
    for (const m of t.matchAll(pattern)) out.push({ start: m.index, end: m.index + m[0].length, act });
  }
  if (lookup) {
    for (const m of t.matchAll(NAME_HEAD)) {
      const head = m[1].toLowerCase();
      const kind = head.startsWith("ústavní") ? "ústavní zákon" : head.startsWith("zákon") ? "zákon" : head.startsWith("vyhláš") ? "vyhláška" : "nařízení vlády";
      const wordsStart = m.index + m[0].length;
      const hit = lookup.byName(kind, t.slice(wordsStart, wordsStart + 160), year);
      if (hit) out.push({ start: m.index, end: wordsStart + hit.length, act: hit.act });
    }
    for (const [alias, act] of lookup.aliases(year)) {
      for (const m of t.matchAll(new RegExp(`${B}${escapeAlias(alias)}${E}`, "gu"))) out.push({ start: m.index, end: m.index + m[0].length, act });
    }
  }
  return dedupeMentions(out);
}

/** Overlapping mentions: the one starting first, the longest on a tie, wins. */
function dedupeMentions(mentions: ActMention[]): ActMention[] {
  const sorted = mentions.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: ActMention[] = [];
  for (const m of sorted) {
    const last = kept.at(-1);
    if (last && m.start < last.end) continue;
    kept.push(m);
  }
  return kept;
}

const DEFINITION_RE = /\(\s*dále\s+(?:jen|též|také|i)?\s*(?:jako\s+)?[„"“]([^”"“„]{1,40})[”"“]\s*(?:nebo\s+[„"“]([^”"“„]{1,40})[”"“]\s*)?\)/gu;
/** How far before "(dále jen" the defined act may be named. */
const DEFINITION_REACH = 300;

export interface Definition {
  alias: string;
  act: string;
  at: number;
}

/**
 * "(dále jen „X“)" definitions bound to the main act of their clause: the
 * first act mention in the reach before it that is not an amendment named
 * after "ve znění", and after the previous definition. Pure.
 */
export function findDefinitions(t: string, mentions: ActMention[]): Definition[] {
  const defs: Definition[] = [];
  let floor = 0;
  for (const m of t.matchAll(DEFINITION_RE)) {
    const from = Math.max(floor, m.index - DEFINITION_REACH);
    const inReach = mentions.filter((x) => x.start >= from && x.end <= m.index);
    const amend = t.slice(from, m.index).search(/ve\s+znění|novel/iu);
    const main = inReach.find((x) => amend === -1 || x.start < from + amend) ?? inReach[0];
    floor = m.index + m[0].length;
    if (!main) continue;
    for (const alias of [m[1], m[2]]) {
      const a = alias?.trim();
      if (a && a.length >= 1) defs.push({ alias: a, act: main.act, at: m.index + m[0].length });
    }
  }
  return defs;
}

// ---------------------------------------------------------------------------
// Provision references.

interface Ref {
  head: string; // "par" | "cl"
  n: string;
  sub: string[][]; // each: path segments below the § / článek (["o1"], ["o1","pb"] …)
}

// A § letter sticks to its number ("§ 243c"): "§ 2910 a 2913" is two paragraphs, not "2910a".
const NUM = /(\d{1,4})([a-z])?(?![\p{L}\p{N}])|([IVXLC]{1,6})(?![\p{L}\p{N}])/uy;
const roman = (s: string) => s.toLowerCase();

function lettersBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let c = a.charCodeAt(0); c <= b.charCodeAt(0) && out.length < 26; c++) out.push(String.fromCharCode(c));
  return out;
}

function numbersBetween(a: number, b: number, cap = 30): string[] {
  if (b < a || b - a > cap) return [String(a), String(b)];
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
}

/**
 * Sub-levels after one § / článek number at `pos`: odstavce, then písmena,
 * then body, each a list or range. Returns the paths (each a list of
 * segments) and the end position. Pure.
 */
function parseSubLevels(t: string, pos: number): { paths: string[][]; end: number } {
  const LIST_SEP = /\s*(?:,|a|nebo|či|resp\.)\s*/uy;
  const RANGE = /\s*(?:až|[-‐‑–])\s*/uy;
  const take = (re: RegExp, at: number) => {
    re.lastIndex = at;
    const m = re.exec(t);
    return m ? { m, end: re.lastIndex } : null;
  };
  let end = pos;
  let odst: string[] = [];
  let pism: string[] = [];
  let bod: string[] = [];
  const o = take(/\s*,?\s*odst\.\s*(\d{1,3})/uy, end);
  if (o) {
    odst = [o.m[1]];
    end = o.end;
    for (;;) {
      const r = take(RANGE, end);
      const rn = r ? take(/(\d{1,3})(?![\p{N}.]|\s*[§/])/uy, r.end) : null;
      if (r && rn) {
        odst = [...odst.slice(0, -1), ...numbersBetween(Number(odst.at(-1)), Number(rn.m[1]), 20)];
        end = rn.end;
        continue;
      }
      const s = take(LIST_SEP, end);
      const sn = s ? take(/(?:odst\.\s*)?(\d{1,3})(?![\p{N}.]|\s*[§/])/uy, s.end) : null;
      if (s && sn) {
        odst.push(sn.m[1]);
        end = sn.end;
        continue;
      }
      break;
    }
  }
  const p = take(/\s*,?\s*písm(?:ene?|eno)?\.?\s*([a-z]{1,2})\)?/uy, end);
  if (p) {
    pism = [p.m[1]];
    end = p.end;
    for (;;) {
      const r = take(RANGE, end);
      const rn = r ? take(/([a-z])\)/uy, r.end) : null;
      if (r && rn) {
        pism = [...pism.slice(0, -1), ...lettersBetween(pism.at(-1)!, rn.m[1])];
        end = rn.end;
        continue;
      }
      const s = take(LIST_SEP, end);
      const sn = s ? take(/(?:písm\.\s*)?([a-z]{1,2})\)/uy, s.end) : null;
      if (s && sn) {
        pism.push(sn.m[1]);
        end = sn.end;
        continue;
      }
      break;
    }
  }
  const b = take(/\s*,?\s*bod(?:u|ů|y|em)?\.?\s*(\d{1,3})(?![\p{N}])/uy, end);
  if (b) {
    bod = [b.m[1]];
    end = b.end;
  }
  // "věty první", "věta druhá", "věty za středníkem": the sentence is a level too.
  let veta: string[] = [];
  const v = take(/\s*,?\s*vět(?:a|y|ou|u|ě)\s+(první|druh\p{L}*|třetí|čtvrt\p{L}*|pát\p{L}*|poslední|před\s+středníkem|za\s+středníkem)/uy, end);
  if (v) {
    const w = v.m[1].toLowerCase();
    veta = [w.startsWith("prv") ? "1" : w.startsWith("dru") ? "2" : w.startsWith("tř") ? "3" : w.startsWith("čtv") ? "4" : w.startsWith("pát") ? "5" : w.startsWith("posl") ? "posl" : w.startsWith("před") ? "pred" : "za"];
    end = v.end;
  }
  const levels: string[][] = [];
  const os = odst.length ? odst.map((x) => `o${x}`) : [null];
  const ps = pism.length ? pism.map((x) => `p${x}`) : [null];
  const bs = bod.length ? bod.map((x) => `b${x}`) : [null];
  const vs = veta.length ? veta.map((x) => `v${x}`) : [null];
  for (const a of os) for (const c of ps) for (const d of bs) for (const e of vs) levels.push([a, c, d, e].filter((x): x is string => x !== null));
  return { paths: levels.filter((l) => l.length > 0), end };
}

const HEAD_RE = /(§§?|(?<![\p{L}])(?:čl\.|[čČ]lán(?:ek|ku|kem|ky|ků|cích)))\s*(?=[\dIVXLC])/gu;

/** Every § / článek reference with its sub-levels and its span. Pure. */
function parseRefs(t: string): Array<{ refs: Ref[]; start: number; end: number }> {
  const out: Array<{ refs: Ref[]; start: number; end: number }> = [];
  for (const m of t.matchAll(HEAD_RE)) {
    const head = m[1].startsWith("§") ? "par" : "cl";
    const refs: Ref[] = [];
    let pos = m.index + m[0].length;
    let prev: Ref | null = null;
    let range = false; // the separator before this number was "až" / a dash
    for (;;) {
      NUM.lastIndex = pos;
      const n = NUM.exec(t);
      if (!n) break;
      if (n[3] && head === "par") break; // roman numerals only for články
      const id = n[1] ? String(Number(n[1])) + (n[2] ?? "") : roman(n[3]);
      pos = NUM.lastIndex;
      const sub = parseSubLevels(t, pos);
      pos = sub.end;
      const ref: Ref = { head, n: id, sub: sub.paths };
      // "§§ 2910 až 2913": the paragraphs between join (up to 30).
      if (prev && range && /^\d+$/.test(prev.n) && /^\d+$/.test(id)) {
        for (const k of numbersBetween(Number(prev.n), Number(id)).slice(1, -1)) refs.push({ head, n: k, sub: [] });
      }
      refs.push(ref);
      prev = ref;
      const sep = /\s*(,|a|až|nebo|či|resp\.|[-‐‑–])\s*(?:§|čl\.\s*)?(?=\d|[IVXLC]{1,6}(?![\p{L}]))/uy;
      sep.lastIndex = pos;
      const s = sep.exec(t);
      if (!s) break;
      range = /až|[-‐‑–]/u.test(s[1]);
      pos = sep.lastIndex;
    }
    if (refs.length) out.push({ refs, start: m.index, end: pos });
  }
  return out;
}

const BACK_REF =
  /^\s*,?\s*(?:téhož|citovan\p{L}*|cit\.|uveden\p{L}*|výše\s+uveden\p{L}*|shora\s+uveden\p{L}*|tohoto|této|daného|předmětn\p{L}*|posledně\s+citovan\p{L}*)\s+(?:zákon\p{L}*|předpis\p{L}*|řád\p{L}*|nařízení|směrnic\p{L}*|vyhlášk\p{L}*|tarif\p{L}*|úmluv\p{L}*|smlouv\p{L}*|listin\p{L}*|zákoník\p{L}*)/iu;
/** Words that may stand between a reference and its act: "§ 2913 zákona č. …" needs none; "§ 2913, ve znění …" is not an act. */
const GAP = /^[\s,]{0,3}$/;

/**
 * The provisions `text` cites, with acts resolved (see the header).
 * `year` (of the decision) picks among acts sharing a name or alias. Pure.
 */
export function extractProvisions(text: string, lookup: ActLookup | null = null, year: number | null = null): ProvisionMention[] {
  const t = text.replace(ODD_SPACES, " ");
  const base = findActMentions(t, lookup, year);
  const defs = findDefinitions(t, base);
  // A defined alias is a mention of its act from its definition on; it beats any global meaning.
  const defined: ActMention[] = [];
  for (const d of defs) {
    for (const m of t.slice(d.at).matchAll(new RegExp(`${B}${escapeAlias(d.alias)}${E}`, "gu"))) {
      defined.push({ start: d.at + m.index, end: d.at + m.index + m[0].length, act: d.act });
    }
  }
  const definedSpans = defined.map((x) => [x.start, x.end] as const);
  const mentions = dedupeMentions([
    ...defined,
    ...base.filter((x) => !definedSpans.some(([s, e]) => x.start < e && s < x.end)),
  ]);

  const out: ProvisionMention[] = [];
  for (const span of parseRefs(t)) {
    const after = mentions.find((x) => x.start >= span.end && GAP.test(t.slice(span.end, x.start)));
    let act = after?.act ?? "";
    if (!act && BACK_REF.test(t.slice(span.end, span.end + 60))) {
      act = [...mentions].reverse().find((x) => x.end <= span.start)?.act ?? "";
    }
    for (const ref of span.refs) {
      const top = `${ref.head}:${ref.n}`;
      const keys = new Set<string>([top]);
      let deepest = top;
      for (const path of ref.sub) {
        for (let i = 1; i <= path.length; i++) keys.add(`${top}/${path.slice(0, i).join("/")}`);
        const key = `${top}/${path.join("/")}`;
        if (key.length > deepest.length) deepest = key;
      }
      out.push({ act, provision: deepest, keys: [...keys], start: span.start, end: span.end });
    }
  }
  return out;
}

export interface ProvisionRow {
  act: string;
  provision: string;
  mentions: number;
  firstAt: number;
}

/** Mentions → one row per (act, key) with how often and where first. Pure. */
export function aggregateProvisions(mentions: ProvisionMention[]): ProvisionRow[] {
  const rows = new Map<string, ProvisionRow>();
  for (const m of mentions) {
    for (const key of m.keys) {
      const id = `${m.act}\u0000${key}`;
      const row = rows.get(id);
      if (row) {
        row.mentions++;
        row.firstAt = Math.min(row.firstAt, m.start);
      } else rows.set(id, { act: m.act, provision: key, mentions: 1, firstAt: m.start });
    }
  }
  return [...rows.values()];
}
