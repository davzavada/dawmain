import {
  ANCHOR_LABELS,
  DOC_TYPE_LABELS,
  DOC_TYPES,
  TEMPLATE_KINDS,
  type BibMeta,
  type DocType,
  type MetaField,
  type MetaSource,
  type ProposedMeta,
} from "@/src/files/types";

/**
 * The metadata review form: which fields each document type shows (plan
 * §3 / BibMeta), how stored metadata becomes form values and back, and the
 * source badges of the proposals. The server validates with bibMetaSchema
 * (strict, Czech messages); these helpers only shape the input so that a
 * type change never sends another type's fields. Pure — unit-tested.
 */

export type FieldKind = "text" | "textarea" | "list" | "year" | "select" | "date";

export interface FieldDef {
  key: MetaField;
  label: string;
  kind: FieldKind;
  /** select: value → label */
  options?: Array<[string, string]>;
  placeholder?: string;
  hint?: string;
  required?: boolean;
}

const TEMPLATE_LABELS: Record<(typeof TEMPLATE_KINDS)[number], string> = {
  smlouva: "smlouva",
  podani: "podání",
  zaloba: "žaloba",
  odvolani: "odvolání",
  dovolani: "dovolání",
  navrh: "návrh",
  plna_moc: "plná moc",
  jine: "jiné",
};

const F = {
  title: { key: "title", label: "Název", kind: "text", required: true },
  subtitle: { key: "subtitle", label: "Podnázev", kind: "text" },
  authors: { key: "authors", label: "Autoři", kind: "list", hint: "Každé jméno na nový řádek." },
  editors: { key: "editors", label: "Editoři / vedoucí autorského kolektivu", kind: "list", hint: "Každé jméno na nový řádek." },
  year: { key: "year", label: "Rok", kind: "year", placeholder: "2024" },
  edition: { key: "edition", label: "Vydání", kind: "text", placeholder: "2." },
  publisher: { key: "publisher", label: "Nakladatel", kind: "text" },
  place: { key: "place", label: "Místo vydání", kind: "text", placeholder: "Praha" },
  series: { key: "series", label: "Edice", kind: "text" },
  isbn: { key: "isbn", label: "ISBN", kind: "list", hint: "Více ISBN (vázaná, PDF) každé na nový řádek." },
  issn: { key: "issn", label: "ISSN", kind: "text", placeholder: "1210-6410" },
  doi: { key: "doi", label: "DOI", kind: "text", placeholder: "10.14712/…" },
  bookTitle: { key: "container_title", label: "Kniha nebo sborník", kind: "text" },
  journal: { key: "container_title", label: "Časopis", kind: "text" },
  volume: { key: "volume", label: "Ročník", kind: "text" },
  issue: { key: "issue", label: "Číslo", kind: "text" },
  pages: { key: "pages_range", label: "Strany", kind: "text", placeholder: "417–425" },
  act: { key: "commented_act", label: "Komentovaný předpis", kind: "text", placeholder: "89/2012 nebo OZ", required: true, hint: "Číslo a rok (89/2012), zkratka (OZ) nebo CELEX." },
  actName: { key: "commented_act_name", label: "Název předpisu", kind: "text", hint: "Doplní se sám, když ho necháte prázdný." },
  anchor: {
    key: "anchor_label",
    label: "Marginální čísla",
    kind: "select",
    options: [["", "—"], ...ANCHOR_LABELS.map((a): [string, string] => [a, a])],
  },
  template: { key: "template_kind", label: "Druh vzoru", kind: "select", options: [["", "—"], ...TEMPLATE_KINDS.map((t): [string, string] => [t, TEMPLATE_LABELS[t]])] },
  court: { key: "court", label: "Soud", kind: "text" },
  caseNumber: { key: "case_number", label: "Spisová značka", kind: "text", placeholder: "25 Cdo 1234/2019" },
  ecli: { key: "ecli", label: "ECLI", kind: "text" },
  decided: { key: "decided_on", label: "Datum rozhodnutí", kind: "date", placeholder: "24. 4. 2019" },
  keywords: { key: "keywords", label: "Klíčová slova", kind: "list", hint: "Nejvýš 8, každé na nový řádek." },
  summary: { key: "summary", label: "Shrnutí", kind: "textarea" },
  language: { key: "language", label: "Jazyk", kind: "text", placeholder: "cs" },
} satisfies Record<string, FieldDef>;

/** Fields per document type, in form order (type and title come first for every type). */
const BY_TYPE: Record<DocType, FieldDef[]> = {
  kniha: [F.subtitle, F.authors, F.editors, F.edition, F.publisher, F.place, F.year, F.series, F.isbn],
  kapitola: [F.authors, F.bookTitle, F.editors, F.pages, F.edition, F.publisher, F.place, F.year, F.isbn],
  clanek: [F.subtitle, F.authors, F.journal, F.year, F.volume, F.issue, F.pages, F.issn, F.doi],
  komentar: [F.act, F.actName, F.editors, F.authors, F.edition, F.publisher, F.place, F.year, F.isbn, F.anchor],
  vzor: [F.template, F.authors, F.year],
  rozhodnuti: [F.court, F.caseNumber, F.decided, F.ecli],
  jine: [F.subtitle, F.authors, F.publisher, F.place, F.year],
};

const TAIL: FieldDef[] = [F.keywords, F.summary, F.language];

export const DOC_TYPE_OPTIONS: Array<[DocType, string]> = DOC_TYPES.map((t) => [t, DOC_TYPE_LABELS[t]]);

/** The editable fields of a type: title, the type's own fields, then keywords, summary, language. */
export function fieldsFor(docType: DocType): FieldDef[] {
  return [F.title, ...(BY_TYPE[docType] ?? BY_TYPE.jine), ...TAIL];
}

export type FormValues = Record<string, string>;

/** Every key the server's strict schema knows (bibMetaBaseSchema). */
const ALL_KEYS: MetaField[] = [
  "doc_type", "title", "subtitle", "authors", "editors", "year", "edition", "publisher", "place", "series", "isbn", "issn", "doi",
  "container_title", "volume", "issue", "pages_range", "commented_act", "commented_act_name", "section_range", "anchor_label",
  "template_kind", "court", "case_number", "ecli", "decided_on", "keywords", "summary", "language",
];

const LIST_KEYS = new Set<MetaField>(["authors", "editors", "isbn", "keywords"]);

/** "2019-04-24" → "24. 4. 2019" (how the form shows dates); anything else unchanged. */
export function czechDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : iso;
}

/** "zak:89/2012" → "89/2012", "eu:32016R0679" → "32016R0679" (the form shows what a person types). */
export function actInput(act: string): string {
  return act.replace(/^zak:/, "").replace(/^eu:/, "");
}

/** Stored metadata → form values (lists one item per line). */
export function formFromMeta(meta: BibMeta): FormValues {
  const out: FormValues = {};
  for (const key of ALL_KEYS) {
    const v = meta[key];
    if (Array.isArray(v)) out[key] = v.join("\n");
    else if (v === null || v === undefined) out[key] = "";
    else if (key === "decided_on") out[key] = czechDate(String(v));
    else if (key === "commented_act") out[key] = actInput(String(v));
    else out[key] = String(v);
  }
  out.doc_type = meta.doc_type;
  out.language ||= "cs";
  return out;
}

/**
 * Form values → the PATCH `meta` object: every key the schema knows, the
 * fields of the chosen type from the form, every other type-specific field
 * empty (so switching kniha → článek does not keep an ISBN the user can no
 * longer see). section_range is derived on the server — sent empty, which
 * keeps the stored value.
 */
export function payloadFromForm(values: FormValues): Record<string, unknown> {
  const docType = (DOC_TYPES as readonly string[]).includes(values.doc_type) ? (values.doc_type as DocType) : "jine";
  const shown = new Set<string>(fieldsFor(docType).map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const key of ALL_KEYS) {
    if (key === "doc_type") out.doc_type = docType;
    else if (key === "section_range") out.section_range = null;
    else if (!shown.has(key)) out[key] = LIST_KEYS.has(key) ? [] : null;
    else if (LIST_KEYS.has(key)) out[key] = (values[key] ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    else out[key] = (values[key] ?? "").trim() || null;
  }
  return out;
}

const SOURCE_LABELS: Record<MetaSource, string> = {
  ai: "návrh AI",
  heuristic: "z textu",
  pdf: "z PDF",
  filename: "z názvu souboru",
  user: "od vás",
};

/** Badge of a proposed field, and whether to highlight it for checking (confidence < 0.5). */
export function proposalBadge(proposed: ProposedMeta | null, key: MetaField): { label: string; low: boolean } | null {
  const field = proposed?.[key] as { source?: MetaSource; confidence?: number } | undefined;
  if (!field || typeof field.source !== "string" || !(field.source in SOURCE_LABELS)) return null;
  const confidence = typeof field.confidence === "number" ? field.confidence : 1;
  return { label: SOURCE_LABELS[field.source], low: field.source !== "user" && confidence < 0.5 };
}
