import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { callDeadline } from "./shared/clock";
import { PDF_PAGES_PER_CALL, extractDocument, type DocumentConverters, type ExtractedDocument } from "./shared/documents";
import { SLOVLEX_GATEWAY, SLOVLEX_LP, SLOVLEX_WEB, actIri, parseActCitation, slovlexJson } from "./slovlex-base";

/**
 * eLegislatíva (www.slov-lex.sk/elegislativa) — Slovak legislative processes
 * (LP/2025/300): the process record (predkladateľ, MPK, NR SR result, the
 * acts it amends and the act it was published as), its stages with dates and,
 * per stage, the accompanying files (dôvodová správa, vlastný materiál,
 * doložka vplyvov, tabuľka zhody, vyhodnotenie MPK …) as DOCX/PDF downloads.
 *
 * Addresses (docs/research/slovlex.md, verified live 17. 11. 2026):
 *   search   POST /internal/elegislativa/legislativne-materialy/filter?page=1&size=10
 *            body: hladanyVyraz (full text — titles AND file texts, words OR-ed,
 *            "…" = phrase), cisloLegislativnehoMaterialu (exact: "LP/2025/300";
 *            "2025/300" answers LP and LPEU of that number), nazov (title words),
 *            rocnik (the LP's year), stadium (code), typKod ("Zakon" …);
 *            an array for stadium → 500. Without sortBy the newest stage start
 *            comes first; sortBy ∈ MPK|datumZaciatkuAktualnehoStadia|typPredpis|nazov
 *            needs sortDirection ASC|DESC in CAPITALS (lowercase → 404).
 *   detail   GET /internal/elegislativa/legislativne-materialy/{LP|LPEU}/{year}/{number}
 *   stages   GET /external/evidencna-aplikacia/legislativne-materialy/{uuid}/historia
 *   files    GET /external/evidencna-aplikacia/legislativne-materialy/{uuid}/sprievodne-dokumenty?stadiumUuid=…
 *            Each stage holds its own SNAPSHOT of the files (new uuids per stage,
 *            revised contents: vlastný materiál 86 kB in MPK, 104 kB at the end);
 *            the last stage's list is a superset (MPK comments, vyhodnotenie,
 *            schválené znenie join later) — not the drafts as they stood earlier.
 *   download GET /external/evidencna-aplikacia/sprievodne-dokumenty/{uuid}/download
 *
 * There is no filter by the resulting act: an act ("325/2025") is resolved
 * through its title from the Zbierka search, the `nazov` filter, and the
 * candidates' detail `vyhlasenyPodCislomList`. Processes migrated from the old
 * system (≈ before 2024) carry no such link, so the lookup finds only recent
 * acts.
 */

export const SOURCE = SLOVLEX_LP;

/** Stages a search can filter by (stadium.hodnota), with the portal's names. */
export const LP_STAGES = {
  PRIPRAVA_MATERIALU: "Príprava materiálu",
  MPK: "Pripomienkové konanie",
  VYHODNOTENIE_MPK: "Vyhodnotenie pripomienkového konania",
  SPRACOVANIE_PREDKLADATEL: "Spracovanie predkladateľom",
  ROKOVANIE_POV: "Rokovanie poradných orgánov vlády SR",
  ROKOVANIE_VLADA: "Rokovanie vlády SR",
  ROKOVANIE_NRSR: "Rokovanie Národnej rady SR",
  PRED_VYHLASENIM_V_ZBIERKE: "Pred vyhlásením v Zbierke zákonov SR",
  VYHLASENE_V_ZBIERKE: "Vyhlásené v Zbierke zákonov SR",
  PROCES_UKONCENY: "Proces ukončený",
} as const;
export type LpStage = keyof typeof LP_STAGES;

/** Document kinds (typ.kod) seen on LP files, with the portal's names. The answer always carries the upstream name; this is the known vocabulary. */
export const LP_DOC_KINDS: Record<string, string> = {
  ObalMaterialu: "Obal materiálu",
  NavrhUzneseniaVladySlovenskejRepubliky: "Návrh uznesenia vlády Slovenskej republiky",
  UznesenieVladySR: "Uznesenie vlády Slovenskej republiky",
  PredkladaciaSprava: "Predkladacia správa",
  VlastnyMaterial: "Vlastný materiál",
  DovodovaSprava: "Dôvodová správa",
  DolozkaVplyvov: "Doložka vplyvov",
  DolozkaZlucitelnosti: "Doložka zlučiteľnosti",
  TabulkaZhody: "Tabuľka zhody",
  SpravaOUcastiVerejnosti: "Správa o účasti verejnosti",
  NavrhVykonavacichPredpisov: "Návrh vykonávacích predpisov",
  InformativneKonsolidovaneZneniePravnehoPredpisu: "Informatívne konsolidované znenie právneho predpisu",
  VznesenePripomienkyVRamciMedzirezortnehoPripomienkovehoKonania: "Vznesené pripomienky v rámci pripomienkového konania",
  VyhodnotenieMedzirezortnehoPripomienkovehoKonania: "Vyhodnotenie pripomienkového konania",
  SchvaleneZnenieZakonaVNRSR: "Schválené znenie zákona v NR SR",
};

const FILTER_URL = `${SLOVLEX_GATEWAY}/internal/elegislativa/legislativne-materialy/filter`;
const DETAIL_BASE = `${SLOVLEX_GATEWAY}/internal/elegislativa/legislativne-materialy`;
const EVIDENCE_BASE = `${SLOVLEX_GATEWAY}/external/evidencna-aplikacia`;
const ZBIERKA_SEARCH = `${SLOVLEX_GATEWAY}/vyhladavanie/predpisZbierky/rozsirene`;

/** Public page of a process. */
export function lpUrl(prefix: string, year: number, number: number): string {
  return `${SLOVLEX_WEB}/elegislativa/legislativne-procesy/SK/${prefix}/${year}/${number}`;
}

export function lpDownloadUrl(documentId: string): string {
  return `${EVIDENCE_BASE}/sprievodne-dokumenty/${encodeURIComponent(documentId)}/download`;
}

/** "LP/2025/300", "LPEU/2026/583", "2025/300", "lp 2025/300" → parts; anything else → null. Pure. */
export function parseLpNumber(input: string): { prefix: string | null; year: number; number: number } | null {
  const m = /^\s*(?:(LPEU|LP)\s*[/ ]\s*)?(\d{4})\s*\/\s*(\d+)\s*$/i.exec(input);
  if (!m) return null;
  return { prefix: m[1] ? m[1].toUpperCase() : null, year: Number(m[2]), number: Number(m[3]) };
}

// ---------------------------------------------------------------- search

export interface LpFilterInput {
  query?: string;
  /** Normalised "LP/2025/300" or bare "2025/300". */
  number?: string;
  title?: string;
  stage?: LpStage;
  year?: number;
  typeCode?: string;
}

/** The filter POST: URL with paging (upstream pages are 1-based) and a body of only the given criteria. Pure — unit-tested. */
export function buildLpFilterRequest(input: LpFilterInput, page: number, size: number): { url: string; body: Record<string, string | number> } {
  const body: Record<string, string | number> = {};
  if (input.query?.trim()) body.hladanyVyraz = input.query.trim();
  if (input.number?.trim()) body.cisloLegislativnehoMaterialu = input.number.trim();
  if (input.title?.trim()) body.nazov = input.title.trim();
  if (input.stage) body.stadium = input.stage;
  if (input.year !== undefined) body.rocnik = input.year;
  if (input.typeCode?.trim()) body.typKod = input.typeCode.trim();
  const params = new URLSearchParams({ page: String(page), size: String(size) });
  return { url: `${FILTER_URL}?${params}`, body };
}

export interface LpHit {
  /** "LP/2025/300" */
  lp: string;
  prefix: string;
  year: number;
  number: number;
  uuid: string;
  type: string;
  title: string;
  stage: string;
  stageCode: string;
  stageFrom?: string;
  url: string;
}

export interface LpSearchResult {
  total: number;
  hits: LpHit[];
}

interface RawStage {
  hodnota?: string | null;
  nazov?: string | null;
}

interface RawFilter {
  totalElements?: number;
  legMaterialList?: Array<{ uuid?: string; typNazov?: string; cisloLegislativnehoMaterialu?: string; nazov?: string; stadium?: RawStage | null; zaciatokStadia?: string | null }>;
}

const clean = (text: string | null | undefined) => (text ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const stageName = (stage: RawStage | null | undefined) => clean(stage?.nazov) || LP_STAGES[stage?.hodnota as LpStage] || clean(stage?.hodnota);

/** The filter's JSON → hits. Pure — unit-tested. */
export function parseLpSearch(json: unknown): LpSearchResult {
  const data = json as RawFilter;
  if (!data || typeof data !== "object" || !Array.isArray(data.legMaterialList)) {
    throw new SourceError(SOURCE, "PARSE_DRIFT", "The eLegislatíva filter answered without legMaterialList.", "The API changed shape — run dawmain_probe_sources; retrying will not help.");
  }
  const hits: LpHit[] = [];
  for (const raw of data.legMaterialList) {
    const parts = parseLpNumber(raw.cisloLegislativnehoMaterialu ?? "");
    if (!parts || !raw.uuid) continue;
    const prefix = parts.prefix ?? "LP";
    hits.push({
      lp: `${prefix}/${parts.year}/${parts.number}`,
      prefix,
      year: parts.year,
      number: parts.number,
      uuid: raw.uuid,
      type: clean(raw.typNazov),
      title: clean(raw.nazov),
      stage: stageName(raw.stadium),
      stageCode: clean(raw.stadium?.hodnota),
      ...(raw.zaciatokStadia ? { stageFrom: raw.zaciatokStadia } : {}),
      url: lpUrl(prefix, parts.year, parts.number),
    });
  }
  return { total: typeof data.totalElements === "number" ? data.totalElements : hits.length, hits };
}

const searchCache = new TtlCache<LpSearchResult>(SEARCH_TTL_MS);
const detailCache = new TtlCache<LpDetail>(DOCUMENT_TTL_MS, 24);
const historyCache = new TtlCache<LpStageRecord[]>(DOCUMENT_TTL_MS, 24);
const documentsCache = new TtlCache<LpDocument[]>(DOCUMENT_TTL_MS, 24);
const fileCache = new TtlCache<ExtractedDocument & { name?: string }>(DOCUMENT_TTL_MS, 6);
const actTitleCache = new TtlCache<string>(SEARCH_TTL_MS);

/** One page of the filter. */
export async function searchLp(input: LpFilterInput, page: number, size: number): Promise<LpSearchResult> {
  const { url, body } = buildLpFilterRequest(input, page, size);
  return searchCache.through(memoKey("lp-search", { url, body }), async () =>
    parseLpSearch(await slovlexJson<unknown>(SOURCE, url, { method: "POST", body, retry: true })),
  );
}

// ---------------------------------------------------------------- detail

export interface LpActRef {
  /** "138/2019 Z. z." */
  citation: string;
  iri: string;
  title: string;
  year?: number;
  number?: number;
}

export interface LpDetail {
  uuid: string;
  lp: string;
  prefix: string;
  year: number;
  number: number;
  title: string;
  type: string;
  typeCode: string;
  stage: string;
  stageCode: string;
  lastChange?: string;
  ministryNumber?: string;
  podnet?: string;
  submitter?: string;
  institution?: string;
  areas: string[];
  mpkFrom?: string;
  mpkTo?: string;
  nrsrResult?: string;
  endReason?: string;
  mainAmended?: LpActRef;
  amended: LpActRef[];
  publishedAs: LpActRef[];
  url: string;
}

interface RawActRef {
  iri?: string | null;
  menovka?: string | null;
  popis?: string | null;
}

interface RawDetail {
  uuid?: string;
  typ?: { nazov?: string; kod?: string } | null;
  oblastList?: Array<{ nazov?: string }> | null;
  cisloLegislativnehoMaterialu?: string;
  nazov?: string;
  stadium?: RawStage | null;
  poslednaZmena?: string | null;
  rezortneCislo?: string | null;
  podnet?: string | null;
  zodpovednyPredkladatel?: { celeMeno?: string } | null;
  zodpovednaInstitucia?: { nazov?: string } | null;
  datumZaciatkuPkMpk?: string | null;
  datumUkonceniaPkMpk?: string | null;
  vysledokNrSr?: string | null;
  dovodUkoncenia?: string | null;
  hlavnyNovelizovanyPredpis?: RawActRef | null;
  novelizovanePredpisy?: RawActRef[] | null;
  vyhlasenyPodCislomList?: RawActRef[] | null;
}

function actRef(raw: RawActRef | null | undefined): LpActRef | undefined {
  if (!raw?.iri && !raw?.menovka) return undefined;
  const iri = clean(raw.iri);
  const parsed = parseActCitation(iri) ?? parseActCitation(clean(raw.menovka));
  return {
    citation: clean(raw.menovka) || iri,
    iri,
    title: clean(raw.popis),
    ...(parsed ? { year: parsed.year, number: parsed.number } : {}),
  };
}

const opt = (text: string | null | undefined) => {
  const value = clean(text);
  return value || undefined;
};

/** The detail JSON → the process record. Pure — unit-tested. */
export function parseLpDetail(json: unknown): LpDetail {
  const raw = json as RawDetail;
  const parts = parseLpNumber(raw?.cisloLegislativnehoMaterialu ?? "");
  if (!raw || typeof raw !== "object" || !raw.uuid || !parts) {
    throw new SourceError(SOURCE, "PARSE_DRIFT", "The eLegislatíva detail answered without uuid or cisloLegislativnehoMaterialu.", "The API changed shape — run dawmain_probe_sources; retrying will not help.");
  }
  const prefix = parts.prefix ?? "LP";
  const list = (items: RawActRef[] | null | undefined) => (items ?? []).map(actRef).filter((ref): ref is LpActRef => !!ref);
  return {
    uuid: raw.uuid,
    lp: `${prefix}/${parts.year}/${parts.number}`,
    prefix,
    year: parts.year,
    number: parts.number,
    title: clean(raw.nazov),
    type: clean(raw.typ?.nazov),
    typeCode: clean(raw.typ?.kod),
    stage: stageName(raw.stadium),
    stageCode: clean(raw.stadium?.hodnota),
    lastChange: opt(raw.poslednaZmena),
    ministryNumber: opt(raw.rezortneCislo),
    podnet: opt(raw.podnet),
    submitter: opt(raw.zodpovednyPredkladatel?.celeMeno),
    institution: opt(raw.zodpovednaInstitucia?.nazov),
    areas: (raw.oblastList ?? []).map((a) => clean(a.nazov)).filter(Boolean),
    mpkFrom: opt(raw.datumZaciatkuPkMpk),
    mpkTo: opt(raw.datumUkonceniaPkMpk),
    nrsrResult: opt(raw.vysledokNrSr),
    endReason: opt(raw.dovodUkoncenia),
    mainAmended: actRef(raw.hlavnyNovelizovanyPredpis),
    amended: list(raw.novelizovanePredpisy),
    publishedAs: list(raw.vyhlasenyPodCislomList),
    url: lpUrl(prefix, parts.year, parts.number),
  };
}

/** One process by its number (prefix LP unless given). 404 → NOT_FOUND. */
export async function getLp(year: number, number: number, prefix = "LP"): Promise<LpDetail> {
  const url = `${DETAIL_BASE}/${prefix}/${year}/${number}`;
  return detailCache.through(url, async () => {
    try {
      return parseLpDetail(await slovlexJson<unknown>(SOURCE, url));
    } catch (error) {
      if (error instanceof SourceError && error.kind === "NOT_FOUND") {
        throw new SourceError(SOURCE, "NOT_FOUND", `eLegislatíva has no process ${prefix}/${year}/${number}.`, "Check the number — sk_lp_search finds processes by words, number or the resulting act.");
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------- stages

export interface LpStageRecord {
  /** historiaRecord uuid = stadiumUuid of its files. */
  uuid: string;
  code: string;
  name: string;
  from?: string;
  to?: string;
  owner?: string;
}

interface RawHistory {
  historiaRecords?: Array<{ uuid?: string; stadium?: RawStage | null; datumZacatia?: string | null; datumUkoncenia?: string | null; vlastnikAktivity?: { skratenyNazov?: string | null; uplnyNazov?: string | null } | null }>;
}

/** The /historia JSON → stages in order. Pure — unit-tested. */
export function parseLpHistory(json: unknown): LpStageRecord[] {
  const data = json as RawHistory;
  if (!data || typeof data !== "object" || !Array.isArray(data.historiaRecords)) {
    throw new SourceError(SOURCE, "PARSE_DRIFT", "The eLegislatíva history answered without historiaRecords.", "The API changed shape — run dawmain_probe_sources; retrying will not help.");
  }
  return data.historiaRecords
    .filter((r) => r.uuid)
    .map((r) => ({
      uuid: r.uuid!,
      code: clean(r.stadium?.hodnota),
      name: stageName(r.stadium),
      ...(r.datumZacatia ? { from: r.datumZacatia } : {}),
      ...(r.datumUkoncenia ? { to: r.datumUkoncenia } : {}),
      ...(opt(r.vlastnikAktivity?.skratenyNazov ?? r.vlastnikAktivity?.uplnyNazov) ? { owner: opt(r.vlastnikAktivity?.skratenyNazov ?? r.vlastnikAktivity?.uplnyNazov) } : {}),
    }));
}

export async function getLpHistory(processUuid: string): Promise<LpStageRecord[]> {
  const url = `${EVIDENCE_BASE}/legislativne-materialy/${encodeURIComponent(processUuid)}/historia`;
  return historyCache.through(url, async () => parseLpHistory(await slovlexJson<unknown>(SOURCE, url)));
}

// ---------------------------------------------------------------- files

export interface LpDocument {
  documentId: string;
  name: string;
  kind: string;
  kindCode: string;
  /** Bytes. */
  size?: number;
}

interface RawDocument {
  uuid?: string;
  nazov?: string;
  velkost?: number | null;
  typ?: { nazov?: string; kod?: string } | null;
}

/** The sprievodne-dokumenty JSON → files, in the portal's order. Pure — unit-tested. */
export function parseLpDocuments(json: unknown): LpDocument[] {
  if (!Array.isArray(json)) {
    throw new SourceError(SOURCE, "PARSE_DRIFT", "The eLegislatíva file list is not an array.", "The API changed shape — run dawmain_probe_sources; retrying will not help.");
  }
  return (json as RawDocument[])
    .filter((d) => d.uuid)
    .map((d) => {
      const kindCode = clean(d.typ?.kod);
      return {
        documentId: d.uuid!,
        name: clean(d.nazov) || d.uuid!,
        kind: clean(d.typ?.nazov) || LP_DOC_KINDS[kindCode] || kindCode || "dokument",
        kindCode,
        ...(typeof d.velkost === "number" ? { size: d.velkost } : {}),
      };
    });
}

export async function getLpDocuments(processUuid: string, stageUuid: string): Promise<LpDocument[]> {
  const url = `${EVIDENCE_BASE}/legislativne-materialy/${encodeURIComponent(processUuid)}/sprievodne-dokumenty?stadiumUuid=${encodeURIComponent(stageUuid)}`;
  return documentsCache.through(url, async () => parseLpDocuments(await slovlexJson<unknown>(SOURCE, url)));
}

// ---------------------------------------------------------------- the whole process

export interface LpProcess {
  detail: LpDetail;
  stages: LpStageRecord[];
  /** 1-based index into stages of the files listed; 0 when the process has no stages. */
  documentsStage: number;
  documents: LpDocument[];
}

/** Budget of the chained detail → historia → files requests. */
const PROCESS_BUDGET_MS = 30_000;

function checkDeadline(deadline: number, what: string): void {
  if (Date.now() > deadline) {
    throw new SourceError(SOURCE, "UPSTREAM_ERROR", `Slov-Lex answered too slowly: the time budget ran out before ${what}.`, "Try again in a minute.");
  }
}

/** How many stages back from the last one to look for files when the last one lists none (e.g. a closed process). */
const EMPTY_STAGE_LOOKBACK = 2;

/**
 * Detail, stages and the files of one stage: `stage` (1-based index into the
 * stages) or, by default, the last stage that lists files (the fullest
 * snapshot). A stage index out of range → INPUT_INVALID.
 */
export async function getLpProcess(year: number, number: number, stage?: number): Promise<LpProcess> {
  const deadline = callDeadline(PROCESS_BUDGET_MS);
  const detail = await getLp(year, number);
  checkDeadline(deadline, "the stage history");
  const stages = await getLpHistory(detail.uuid);
  if (stage !== undefined) {
    if (stage < 1 || stage > stages.length) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `${detail.lp} has ${stages.length} stage(s); stage ${stage} does not exist.`,
        stages.length ? `Pass stage 1–${stages.length} (sk_lp_get_process without stage lists them), or omit it for the last stage.` : "Omit stage — this process records no stages.",
      );
    }
    checkDeadline(deadline, "the stage's files");
    return { detail, stages, documentsStage: stage, documents: await getLpDocuments(detail.uuid, stages[stage - 1].uuid) };
  }
  for (let i = stages.length - 1; i >= Math.max(0, stages.length - 1 - EMPTY_STAGE_LOOKBACK); i--) {
    checkDeadline(deadline, "the stage's files");
    const documents = await getLpDocuments(detail.uuid, stages[i].uuid);
    if (documents.length) return { detail, stages, documentsStage: i + 1, documents };
  }
  return { detail, stages, documentsStage: stages.length, documents: [] };
}

// ---------------------------------------------------------------- the act → its process

/** Candidates whose detail is read to find the process an act came from. */
const ACT_CANDIDATES = 10;

async function actTitle(year: number, number: number): Promise<string | null> {
  const params = new URLSearchParams({ cislo: `${number}/${year}`, rows: "5", start: "0" });
  const url = `${ZBIERKA_SEARCH}?${params}`;
  const cached = actTitleCache.get(url);
  if (cached !== undefined) return cached || null;
  const data = await slovlexJson<{ docs?: Array<{ iri?: string; cislo?: string; nazov?: string }> }>(SOURCE, url);
  const doc = (data.docs ?? []).find((d) => {
    const parsed = parseActCitation(d.iri ?? "") ?? parseActCitation(d.cislo ?? "");
    return parsed?.year === year && parsed.number === number;
  });
  const title = clean(doc?.nazov);
  actTitleCache.set(url, title);
  return title || null;
}

export interface LpActLookup {
  /** The act's title from the Zbierka, null when the Zbierka does not know the act. */
  actTitle: string | null;
  /** Processes whose detail names the act in vyhlasenyPodCislomList. */
  hits: LpHit[];
  /** Title matches read and rejected (no link to the act). */
  checked: number;
}

/**
 * The process(es) an act was published from: the act's title from the
 * Zbierka → the `nazov` filter (with the other criteria) → the first
 * ACT_CANDIDATES details, kept when vyhlasenyPodCislomList names the act.
 */
export async function findLpByAct(act: string, extra: Omit<LpFilterInput, "title" | "number"> = {}): Promise<LpActLookup> {
  const parsed = parseActCitation(act);
  if (!parsed) {
    throw new SourceError(SOURCE, "INPUT_INVALID", `"${act}" is not a Zbierka citation.`, 'Pass act as "325/2025" or "325/2025 Z. z.".');
  }
  const deadline = callDeadline(PROCESS_BUDGET_MS);
  const title = await actTitle(parsed.year, parsed.number);
  if (!title) return { actTitle: null, hits: [], checked: 0 };
  checkDeadline(deadline, "the process search");
  const candidates = (await searchLp({ ...extra, title }, 1, ACT_CANDIDATES)).hits.filter((hit) => hit.prefix === "LP");
  checkDeadline(deadline, "the process details");
  const iri = actIri(parsed.year, parsed.number);
  const details = await Promise.all(candidates.map((hit) => getLp(hit.year, hit.number).catch(() => null)));
  const hits = candidates.filter((_hit, i) =>
    details[i]?.publishedAs.some((ref) => ref.iri === iri || (ref.year === parsed.year && ref.number === parsed.number)),
  );
  return { actTitle: title, hits, checked: candidates.length };
}

// ---------------------------------------------------------------- download

/** "attachment; filename=\"04_vseobecna.docx\"" / filename*=UTF-8''… → the name. Pure. */
export function dispositionName(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
  const name = (plain?.[1] ?? plain?.[2])?.trim();
  return name || undefined;
}

/**
 * The text of one LP file by its uuid: DOCX through mammoth, PDF through the
 * Vlastní zdroje converter (only `pdfRange`), HTML as text; legacy .doc/RTF →
 * UPSTREAM_ERROR with the download link.
 */
export async function getLpDocumentText(
  documentId: string,
  pdfRange: [number, number] = [1, PDF_PAGES_PER_CALL],
  converters?: DocumentConverters,
): Promise<ExtractedDocument & { name?: string }> {
  const url = lpDownloadUrl(documentId);
  const key = memoKey("lp-doc", { documentId, pdfRange });
  return fileCache.through(key, async () => {
    const response = await fetchUpstream(SOURCE, url, { headers: { accept: "*/*" }, timeoutMs: 25_000 });
    if (response.status === 404 || response.status === 400) {
      void response.body?.cancel().catch(() => {});
      throw new SourceError(SOURCE, "NOT_FOUND", `eLegislatíva has no file ${documentId} (HTTP ${response.status}).`, "document_id comes from sk_lp_get_process's file list (each stage has its own file ids).");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new SourceError(SOURCE, "UPSTREAM_ERROR", `Slov-Lex answered HTTP ${response.status} for ${url}.`, "Try again in a minute.");
    }
    const name = dispositionName(response.headers.get("content-disposition"));
    const bytes = await response.arrayBuffer();
    const extracted = await extractDocument(SOURCE, { bytes, url }, pdfRange, { label: name ?? documentId, converters });
    return { ...extracted, ...(name ? { name } : {}) };
  });
}
