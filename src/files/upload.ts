import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getAccess } from "./access";
import { LIBRARY_ID_RE, LIMITS, TERMS_VERSION, USER_ID_RE } from "./config";
import { withScope, type Queryable } from "./db/client";
import { insertUploadedDocument, isBlocked } from "./db/documents";
import { ensureLibrary, getLibraries, reservePages, reviveLibrary } from "./db/libraries";
import { acceptTerms, audit, bumpUsage, hasAcceptedTerms, usageSum } from "./db/usage";
import { billablePages } from "./dmd/billing";
import { normalizeDmd, sanitizeLine } from "./dmd/normalize";
import { parseDmd } from "./dmd/parse";
import { DmdLimitError, type ParsedDoc } from "./dmd/types";
import { FilesUserError, logFilesError, MESSAGES } from "./errors";
import { effectiveMode, envOnlyMode } from "./guards";
import { CpuMeter } from "./ingest";
import { writeScope } from "./scope";
import {
  DOC_TYPES,
  FILE_KINDS,
  PAGE_LABEL_SOURCES,
  RIGHTS,
  type ConversionQuality,
  type FileKind,
  type UploadHints,
  type UploadMeta,
} from "./types";

/**
 * The core of POST /api/files/documents (the route is a thin wrapper that
 * authenticates the session and schedules ingest). The browser converted
 * the file; what arrives is multipart/form-data with two parts:
 *
 *   meta   JSON UploadMeta (src/files/types.ts)
 *   dmd    the UTF-8 DMD text, gzip-compressed
 *
 * Nothing the client says is trusted. In order — cheap and I/O-free first,
 * the database only for a Pro caller:
 *   1. env mode; body size (Content-Length AND the bytes actually read —
 *      a proxy may truncate silently); multipart + meta schema;
 *   2. access from Clerk (fresh): Pro library, canUpload, not banned;
 *      effective mode (guards) — readonly/off → 503;
 *   3. terms (an upload accepts them, see the note at the upload field);
 *      the daily volume (usage_daily): uploads per library
 *      and in all, CPU time of uploads and ingests today and over 30 days
 *      (UPLOAD_GUARDS) — a quick refusal before the costly steps;
 *   4. streaming gunzip with a byte cap and a ratio cap (zip bomb), strict
 *      UTF-8, SHA-256 of the bytes = meta.content.sha256 (truncation);
 *   5. normalizeDmd, parseDmd with its safety caps (DmdLimitError → 413 for
 *      size, 422 for structure), scan heuristic, billable pages from the
 *      server's own parse; the content hash is that of the normalized
 *      text — what is stored (the browser sends normalized text, so for it
 *      both hashes agree);
 *   6. one transaction: blocked content (notice-and-action), library row,
 *      atomic page
 *      reservation against the library and global caps, a library its
 *      owner uses again is revived (reviveLibrary), insert (duplicate
 *      content in the library → 409, reservation rolled back), the daily
 *      counters bumped and re-checked (a concurrent upload waits on the
 *      counter row; over the limit → 429, everything rolled back), audit.
 * Every refusal is a fixed Czech message; unexpected errors are logged
 * without content and answered 503.
 */

export type UploadOutcome =
  | { status: 201; id: string; libraryId: string }
  | { status: 409; duplicate: { id: string; title: string | null } }
  | { status: 400 | 403 | 413 | 422 | 429 | 503; error: string };

/** The JSON part is small; anything bigger is not ours. */
const MAX_META_BYTES = 256 * 1024;
/** Decompression may always reach this, whatever the ratio (tiny gzip members). */
const RATIO_FLOOR_BYTES = 1024 * 1024;
/** ≥ this share of near-empty pages (and at least two of them) = a scan without a text layer. */
const SCAN_SHARE = 0.3;
const SCAN_MIN_CHARS = 40;

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Global daily volume. Overusing a Vercel Hobby allowance pauses the whole
 * team, the public MCP endpoint included, and the feature may take at most
 * a quarter of it (plan §8): of the 4 h of Active CPU a month that is 1 h
 * per 30 days for uploads and ingests together (usage_daily.cpu_ms,
 * measured by both), with a day allowed up to 10 minutes of it; and at most
 * 200 uploads a day in all (each up to 4.4 MB of request body). cpu_ms is
 * the feature's own parse/derive/hash work (CpuMeter, synchronous sections
 * only — never another request's CPU on the same instance), so it
 * understates the Active CPU billed by the request overhead (Clerk, the
 * database driver, TLS); compare it with the Vercel usage page. The caps
 * live in LIMITS with env overrides (FILES_GLOBAL_UPLOADS_PER_DAY,
 * FILES_CPU_MS_DAY, FILES_CPU_MS_30D), read at call time.
 */
export const UPLOAD_GUARDS = {
  /** FILES_GLOBAL_UPLOADS_PER_DAY, default 200 (LIMITS). */
  get globalUploadsPerDay(): number {
    return LIMITS.globalUploadsPerDay;
  },
  /** FILES_CPU_MS_DAY, default 10 min (LIMITS). */
  get globalCpuMsPerDay(): number {
    return LIMITS.globalCpuMsPerDay;
  },
  /** FILES_CPU_MS_30D, default 60 min (LIMITS). */
  get globalCpuMs30Days(): number {
    return LIMITS.globalCpuMs30Days;
  },
};

const LIBRARY_DAY_FULL = `Do této knihovny se dnes nahrálo už ${LIMITS.uploadsPerLibraryPerDay} dokumentů. Další půjde nahrát zítra.`;
const GLOBAL_DAY_FULL = "Vlastní zdroje dnes přijaly tolik dokumentů, kolik služba za den zvládne zpracovat. Další půjde nahrát zítra.";
const CPU_DAY_FULL = "Zpracování nahraných dokumentů dnes vyčerpalo výpočetní rezervu služby. Další dokumenty půjde nahrát zítra.";
const CPU_MONTH_FULL =
  "Zpracování nahraných dokumentů vyčerpalo výpočetní rezervu služby na posledních 30 dní. Nahrávání bude znovu možné během několika dní.";

// ---------------------------------------------------------------------------
// Meta schema

const qualitySchema = z.object({
  footnotes: z.enum(["linked", "partial", "none", "unsure"]),
  linked_ratio: z.number().min(0).max(1),
  columns_pages: z.number().int().min(0).max(1_000_000),
  headings_from: z.string().max(40),
  mn: z.number().int().min(0).max(10_000_000),
  numbering: z.enum(["ok", "lost"]).optional(),
  ocr: z.boolean().optional(),
  unsure_pages: z.array(z.number().int().min(1).max(1_000_000)).max(10_000),
});

const PDF_INFO_KEYS = ["title", "author", "subject", "keywords", "producer", "creator"] as const;

const hintsSchema = z.object({
  pdf_info: z.record(z.string(), z.unknown()).optional(),
  running_heads: z
    .array(z.object({ page: z.number().int().min(1).max(1_000_000), text: z.string().max(2_000) }))
    .max(20_000)
    .optional(),
});

const uploadMetaSchema = z.object({
  library_id: z.string().regex(LIBRARY_ID_RE),
  file: z.object({
    name: z.string().min(1).max(1_000),
    bytes: z.number().int().min(0).max(10_000_000_000),
    sha256: z.string().regex(HEX64),
    kind: z.enum(FILE_KINDS),
  }),
  converter: z.string().regex(/^[A-Za-z0-9@._+-]{1,40}$/),
  content: z.object({ sha256: z.string().regex(HEX64), chars: z.number().int().min(0).max(100_000_000) }),
  pages: z.object({ physical: z.number().int().min(0).max(1_000_000), label_source: z.enum(PAGE_LABEL_SOURCES) }).optional(),
  quality: qualitySchema,
  hints: hintsSchema.default({}),
  rights: z.enum(RIGHTS),
  doc_type_hint: z.enum(DOC_TYPES).optional(),
});

/** Base name of a client file name, one line, ≤ 255 chars. Pure. */
export function cleanFileName(name: string): string {
  return sanitizeLine(name.replace(/^.*[\\/]/, ""), 255) || "dokument";
}

/**
 * Hints are display-only and end up in the metadata prompt: keep the known
 * PDF info keys and running heads, each sanitized to one bounded line, and
 * at most 2,000 heads. Pure.
 */
export function sanitizeHints(hints: z.infer<typeof hintsSchema>): UploadHints {
  const out: UploadHints = {};
  const info: NonNullable<UploadHints["pdf_info"]> = {};
  for (const key of PDF_INFO_KEYS) {
    const v = hints.pdf_info?.[key];
    if (typeof v === "string") {
      const s = sanitizeLine(v, 300);
      if (s) info[key] = s;
    }
  }
  if (Object.keys(info).length > 0) out.pdf_info = info;
  const heads = (hints.running_heads ?? [])
    .map((h) => ({ page: h.page, text: sanitizeLine(h.text, 200) }))
    .filter((h) => h.text !== "")
    .slice(0, 2_000);
  if (heads.length > 0) out.running_heads = heads;
  return out;
}

/** Parse and validate the JSON part; null when anything is off. Pure. */
export function parseUploadMeta(raw: string): UploadMeta | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = uploadMetaSchema.safeParse(json);
  if (!parsed.success) return null;
  const m = parsed.data;
  return {
    library_id: m.library_id,
    file: { name: cleanFileName(m.file.name), bytes: m.file.bytes, sha256: m.file.sha256.toLowerCase(), kind: m.file.kind as FileKind },
    converter: m.converter,
    content: { sha256: m.content.sha256.toLowerCase(), chars: m.content.chars },
    pages: m.pages,
    quality: m.quality as ConversionQuality,
    hints: sanitizeHints(m.hints),
    rights: m.rights,
    doc_type_hint: m.doc_type_hint,
  };
}

// ---------------------------------------------------------------------------
// Body, gzip, text

/** Read at most `max` bytes of a body; null when it is longer. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Streaming gunzip with an output cap: min(maxTextBytes, max(ratio × input,
 * 1 MB)). Stops reading the moment the cap is passed — a gzip bomb never
 * gets inflated in full. Throws FilesUserError 413 (too big) / 400 (not gzip).
 */
export async function gunzipCapped(gz: Uint8Array): Promise<Uint8Array> {
  const cap = Math.min(LIMITS.maxTextBytes, Math.max(LIMITS.maxGzipRatio * gz.byteLength, RATIO_FLOOR_BYTES));
  const stream = new Blob([gz as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new FilesUserError(413, "Text dokumentu je po rozbalení příliš velký. Vyberte menší rozsah stran.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof FilesUserError) throw error;
    throw new FilesUserError(400, "Text dokumentu nedorazil jako platný gzip. Zkuste nahrání zopakovat.");
  }
  return concat(chunks, total);
}

/** Share (0–1) of pages with fewer than 40 visible characters (page markers excluded). Pure. */
export function sparsePageShare(parsed: ParsedDoc): number {
  if (!parsed.paged || parsed.pages.length === 0) return 0;
  let sparse = 0;
  for (const page of parsed.pages) {
    const visible = parsed.text
      .slice(page.start, page.end)
      .replace(/\[s\. [^\]\n]{1,12}\]/g, "")
      .replace(/\s+/g, "");
    if (visible.length < SCAN_MIN_CHARS) sparse += 1;
  }
  return sparse / parsed.pages.length;
}

/**
 * Instruction-like text aimed at an AI reader (prompt injection): "ignore
 * previous instructions", role prefixes, tool names, the tools' own prose.
 * A hit only sets documents.injection_flag — shown as a warning next to the
 * document in tool output and on the web; it never blocks. Pure.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:(?:the|your)\s+)?(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules|messages|directions)/i,
  /(?:ignoruj|ignorujte|zapomeň|zapomeňte|nedbej|nedbejte)\s+(?:na\s+)?(?:všechny\s+|veškeré\s+)?(?:předchozí|dosavadní|předešlé|výše\s+uvedené|systémové)\s+(?:pokyny|instrukce|zprávy|pravidla)/iu,
  /\bsystem\s+prompt\b/i,
  /systémov(?:ý|é|ého)\s+(?:prompt|pokyn)/iu,
  /^[ ]*(?:system|assistant|developer)[ ]*:/im,
  /<\s*\/?\s*(?:system|assistant|instructions?|tool_call|function_calls?|antml:[a-z_]+)\b/i,
  /\b(?:send_message|create_draft|tool_call|function_call|files_get_document|files_search|files_list)\b/,
  /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|language\s+model|chatgpt|claude)\b/i,
  /pokračuj\s+bez\s+ptaní/iu,
  /VLASTNÍ DOKUMENT/u,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------

const refuse = (status: 400 | 403 | 413 | 422 | 429 | 503, error: string): UploadOutcome => ({ status, error });

/** Carries an outcome out of the transaction so everything in it rolls back. */
class Rollback extends Error {
  constructor(public readonly outcome: UploadOutcome) {
    super("rollback");
    this.name = "Rollback";
  }
}

function modeRefusal(mode: string): UploadOutcome | null {
  if (mode === "on") return null;
  return refuse(503, mode === "readonly" ? MESSAGES.readonly : MESSAGES.off);
}

function limitRefusal(error: DmdLimitError): UploadOutcome {
  const size = error.limit === "maxChars" || error.limit === "maxPages";
  return refuse(size ? 413 : 422, `${error.message} Vyberte menší rozsah nebo dokument rozdělte.`);
}

/** Parse the multipart body into the meta and the gzip bytes. */
async function readForm(request: Request): Promise<{ meta: UploadMeta; gz: Uint8Array } | UploadOutcome> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) return refuse(400, "Nahrávání musí být multipart/form-data.");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LIMITS.maxUploadBytes) {
    return refuse(413, "Nahrávaný text je příliš velký. Vyberte menší rozsah stran.");
  }
  const body = await readCapped(request.body, LIMITS.maxUploadBytes);
  if (!body) return refuse(413, "Nahrávaný text je příliš velký. Vyberte menší rozsah stran.");
  let form: FormData;
  try {
    form = await new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } }).formData();
  } catch {
    return refuse(400, MESSAGES.badRequest);
  }
  const metaPart = form.get("meta");
  const dmdPart = form.get("dmd");
  const metaText =
    typeof metaPart === "string" ? metaPart : metaPart instanceof Blob && metaPart.size <= MAX_META_BYTES ? await metaPart.text() : null;
  if (metaText === null || metaText.length > MAX_META_BYTES || !(dmdPart instanceof Blob) || dmdPart.size === 0) {
    return refuse(400, MESSAGES.badRequest);
  }
  const meta = parseUploadMeta(metaText);
  if (!meta) return refuse(400, "Údaje o nahrávaném dokumentu jsou neplatné.");
  return { meta, gz: new Uint8Array(await dmdPart.arrayBuffer()) };
}

export async function handleDocumentUpload(request: Request, userId: string): Promise<UploadOutcome> {
  try {
    return await upload(request, userId);
  } catch (error) {
    if (error instanceof FilesUserError && isOutcomeStatus(error.status)) return refuse(error.status, error.message);
    logFilesError("upload", error);
    return refuse(503, MESSAGES.unavailable);
  }
}

function isOutcomeStatus(s: number): s is 400 | 403 | 413 | 422 | 429 | 503 {
  return s === 400 || s === 403 || s === 413 || s === 422 || s === 429 || s === 503;
}

/** The daily volume of step 3; null when an upload may start. */
async function volumeRefusal(db: Queryable, libraryId: string): Promise<UploadOutcome | null> {
  if ((await usageSum(db, libraryId, "uploads", 1)) >= LIMITS.uploadsPerLibraryPerDay) return refuse(429, LIBRARY_DAY_FULL);
  if ((await usageSum(db, "global", "uploads", 1)) >= UPLOAD_GUARDS.globalUploadsPerDay) return refuse(429, GLOBAL_DAY_FULL);
  if ((await usageSum(db, "global", "cpu_ms", 1)) >= UPLOAD_GUARDS.globalCpuMsPerDay) return refuse(429, CPU_DAY_FULL);
  if ((await usageSum(db, "global", "cpu_ms", 30)) >= UPLOAD_GUARDS.globalCpuMs30Days) return refuse(429, CPU_MONTH_FULL);
  return null;
}

async function upload(request: Request, userId: string): Promise<UploadOutcome> {
  if (!USER_ID_RE.test(userId)) return refuse(403, MESSAGES.signIn);
  const cpu = new CpuMeter();
  const envRefusal = modeRefusal(envOnlyMode());
  if (envRefusal) return envRefusal;

  // 1. Request shape — no I/O yet.
  const form = await readForm(request);
  if ("status" in form) return form;
  const { meta, gz } = form;
  const libraryId = meta.library_id;

  // 2. Who: Clerk, fresh (a revoked Pro or membership must not keep uploading for a minute).
  const access = await getAccess(userId, { fresh: true });
  const { library } = writeScope(access, libraryId); // 403 for foreign, unknown, non-Pro
  const guardRefusal = modeRefusal(await effectiveMode());
  if (guardRefusal) return guardRefusal;

  // 3. Terms and the daily volume (re-checked atomically in step 6).
  const pre = await withScope([libraryId], async (db) => {
    // The rules are stated next to the upload field: uploading accepts them (recorded once per version).
    if (!(await hasAcceptedTerms(db, userId, TERMS_VERSION))) await acceptTerms(db, userId, TERMS_VERSION);
    return volumeRefusal(db, libraryId);
  });
  if (pre) return pre;

  // 4. The text: capped gunzip, strict UTF-8, the hash the client computed.
  const raw = await cpu.runAsync(() => gunzipCapped(gz));
  if (cpu.run(() => createHash("sha256").update(raw).digest("hex")) !== meta.content.sha256) {
    return refuse(400, "Kontrolní součet textu nesouhlasí — nahrávání se nejspíš přerušilo. Zkuste to znovu.");
  }
  let decoded: string;
  try {
    decoded = cpu.run(() => new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return refuse(400, "Text dokumentu není platné UTF-8.");
  }

  // 5. The server's own parse decides pages, price and plausibility.
  const text = cpu.run(() => normalizeDmd(decoded).text);
  let parsed: ParsedDoc;
  try {
    parsed = cpu.run(() => parseDmd(text));
  } catch (error) {
    if (error instanceof DmdLimitError) return limitRefusal(error);
    throw error;
  }
  if (parsed.stats.countedChars < SCAN_MIN_CHARS) return refuse(422, "Dokument neobsahuje žádný text.");
  const sparse = cpu.run(() => sparsePageShare(parsed));
  // One blank page in a two-page print is not a scan: at least two near-empty pages are required.
  if (sparse >= SCAN_SHARE && Math.round(sparse * parsed.pages.length) >= 2) {
    return refuse(
      422,
      `Dokument vypadá jako sken bez textové vrstvy (${Math.round(sparse * 100)} % stran je téměř prázdných). Nahrajte verzi s rozpoznaným textem (OCR).`,
    );
  }
  const pages = billablePages(parsed.stats.countedChars);
  const injectionFlag = cpu.run(() => looksLikeInjection(text));
  // Dedupe and takedown compare what is stored: invisible characters the
  // normalization drops, or a BOM the decoder drops, must not make the same
  // text a different document — always the hash of the normalized text.
  const contentSha256 = cpu.run(() => createHash("sha256").update(text, "utf8").digest("hex"));

  // 6. One transaction: all or nothing.
  try {
    return await withScope([libraryId], async (db) => {
      if (
        (await isBlocked(db, contentSha256)) ||
        (contentSha256 !== meta.content.sha256 && (await isBlocked(db, meta.content.sha256)))
      ) {
        return refuse(422, "Tento obsah byl na základě oznámení odstraněn a nelze ho nahrát znovu.");
      }
      await ensureLibrary(db, libraryId, library.name);
      const reserved = await reservePages(db, libraryId, pages, library.quotaPages, LIMITS.globalPages);
      if (reserved === "global") {
        return refuse(403, "Úložiště Vlastních zdrojů je teď plné. Zkuste to prosím později.");
      }
      if (reserved === "library") {
        const [row] = await getLibraries(db, [libraryId]);
        const left = Math.max(0, library.quotaPages - (row ? row.page_count + row.pages_reserved : 0));
        return refuse(
          403,
          `Dokument má ${pages} normostran, v knihovně zbývá ${left} z ${library.quotaPages}. Smažte některý dokument nebo vyberte menší rozsah.`,
        );
      }
      const revived = await reviveLibrary(db, libraryId);
      const inserted = await insertUploadedDocument(db, {
        libraryId,
        uploadedBy: userId,
        meta,
        contentSha256,
        charCount: text.length,
        billablePages: pages,
        physicalPages: parsed.paged ? parsed.stats.physicalPages : null,
        pendingGz: gz,
        quality: meta.quality,
        hints: meta.hints,
        injectionFlag,
      });
      if ("duplicate" in inserted) throw new Rollback({ status: 409, duplicate: inserted.duplicate });
      // Bump, then read: the upsert holds the counter row until commit, so a
      // concurrent upload waits here and then sees this one.
      const cpuMs = cpu.ms;
      await bumpUsage(db, libraryId, { uploads: 1, pages, cpu_ms: cpuMs });
      if ((await usageSum(db, libraryId, "uploads", 1)) > LIMITS.uploadsPerLibraryPerDay) {
        throw new Rollback(refuse(429, LIBRARY_DAY_FULL));
      }
      await bumpUsage(db, "global", { uploads: 1, pages, cpu_ms: cpuMs });
      if ((await usageSum(db, "global", "uploads", 1)) > UPLOAD_GUARDS.globalUploadsPerDay) {
        throw new Rollback(refuse(429, GLOBAL_DAY_FULL));
      }
      if (revived) await audit(db, { libraryId, actor: userId, action: "library.revived" });
      await audit(db, {
        libraryId,
        actor: userId,
        action: "document.upload",
        docId: inserted.id,
        detail: { pages, injection: injectionFlag },
      });
      return { status: 201 as const, id: inserted.id, libraryId };
    });
  } catch (error) {
    if (error instanceof Rollback) return error.outcome;
    throw error;
  }
}
