/**
 * Domain types shared by every layer of "Vlastní zdroje" — the browser
 * converter, the upload route, ingest, the MCP tools and the web pages.
 * Pure types and a few literal lists; no I/O, safe to import anywhere
 * (including client components).
 */

export const DOC_TYPES = ["kniha", "kapitola", "clanek", "komentar", "vzor", "rozhodnuti", "jine"] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Czech labels for the UI and the tool output. */
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  kniha: "kniha",
  kapitola: "kapitola v knize",
  clanek: "článek",
  komentar: "komentář",
  vzor: "vzor",
  rozhodnuti: "rozhodnutí",
  jine: "jiné",
};

export const DOC_STATUSES = ["queued", "processing", "review", "ready", "error", "deleting"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const FILE_KINDS = ["pdf", "docx", "txt", "md"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** What the uploader declares about their right to store the text. */
export const RIGHTS = ["vlastni", "verejne", "licence", "jine"] as const;
export type Rights = (typeof RIGHTS)[number];
export const RIGHTS_LABELS: Record<Rights, string> = {
  vlastni: "vlastní dílo nebo poznámky",
  verejne: "veřejný materiál (úřední dílo, volně dostupný text)",
  licence: "licence mi uložení a sdílení v knihovně dovoluje",
  jine: "jiné — odpovídám za to, že k tomu mám právo",
};

export const PAGE_LABEL_SOURCES = ["pdf_labels", "printed", "physical", "none"] as const;
export type PageLabelSource = (typeof PAGE_LABEL_SOURCES)[number];

export const ANCHOR_LABELS = ["m. č.", "marg. č.", "bod"] as const;
export type AnchorLabel = (typeof ANCHOR_LABELS)[number];

export const TEMPLATE_KINDS = ["smlouva", "podani", "zaloba", "odvolani", "dovolani", "navrh", "plna_moc", "jine"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * Bibliographic metadata of one document — what the AI proposes and the
 * user confirms. Every field is optional except the type, title and the
 * arrays; identifiers are stored normalized (see src/files/index/identifiers.ts).
 */
export interface BibMeta {
  doc_type: DocType;
  title: string;
  subtitle?: string | null;
  authors: string[];
  editors: string[];
  year?: number | null;
  edition?: string | null;
  publisher?: string | null;
  place?: string | null;
  series?: string | null;
  isbn: string[];
  issn?: string | null;
  doi?: string | null;
  /** Journal / host book of an article or chapter. */
  container_title?: string | null;
  volume?: string | null;
  issue?: string | null;
  /** Printed page range of an article or chapter, e.g. "417–425". */
  pages_range?: string | null;
  /** Commentary: the act it comments — "zak:89/2012" or "eu:32016R0679". */
  commented_act?: string | null;
  commented_act_name?: string | null;
  /** Commentary: § range covered, derived from the sections, never from AI. */
  section_range?: string | null;
  anchor_label?: AnchorLabel | null;
  template_kind?: TemplateKind | null;
  /** Decision (when someone uploads one): court, sp. zn., ECLI, date. */
  court?: string | null;
  case_number?: string | null;
  ecli?: string | null;
  decided_on?: string | null; // ISO date
  keywords: string[];
  summary?: string | null;
  language: string; // "cs", "sk", "en", "de"…
}

export type MetaField = keyof BibMeta;

/** Where a proposed value came from — shown as a badge in the review form. */
export type MetaSource = "ai" | "heuristic" | "pdf" | "filename" | "user";

export interface ProposedField<T = unknown> {
  value: T;
  source: MetaSource;
  /** 0–1; below 0.5 the form highlights the field for checking. */
  confidence: number;
}

/** proposed_meta JSONB: one entry per field that has a proposal. */
export type ProposedMeta = Partial<{ [K in MetaField]: ProposedField<BibMeta[K]> }>;

/** Conversion quality summary — computed by the converter, re-checked by the server. */
export interface ConversionQuality {
  footnotes: "linked" | "partial" | "none" | "unsure";
  /** Share of footnote definitions bound to a reference (0–1). */
  linked_ratio: number;
  /** Pages laid out in two columns. */
  columns_pages: number;
  /** Where headings came from: "outline" | "styles" | "patterns" | "docx" | "none". */
  headings_from: string;
  /** Marginal numbers recognised. */
  mn: number;
  /** DOCX automatic numbering (Čl. III, 3.2) lost in conversion. */
  numbering?: "ok" | "lost";
  /** OCR'd text layer detected — plain mode (no footnotes, headings, m. č.). */
  ocr?: boolean;
  /** 1-based physical pages the converter was unsure about. */
  unsure_pages: number[];
}

/** Hints the browser sends next to the text. Display and metadata only — never indexed. */
export interface UploadHints {
  pdf_info?: Partial<Record<"title" | "author" | "subject" | "keywords" | "producer" | "creator", string>>;
  /** Running heads removed from the body — they carry §, authors, journal and issue. */
  running_heads?: Array<{ page: number; text: string }>;
}

/** The JSON part of POST /api/files/documents. The text travels as a gzip part. */
export interface UploadMeta {
  library_id: string;
  file: { name: string; bytes: number; sha256: string; kind: FileKind };
  converter: string; // e.g. "pdf@1"
  content: { sha256: string; chars: number };
  pages?: { physical: number; label_source: PageLabelSource };
  quality: ConversionQuality;
  hints: UploadHints;
  rights: Rights;
  doc_type_hint?: DocType;
  /** Re-upload of an existing document (better conversion): keeps confirmed metadata. */
  replaces?: string;
}
