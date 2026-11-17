/**
 * The databases the home page lists, with the shape of their status and the
 * time format the badges use. Pure data and formatting, no I/O: the client
 * components that render the badges (app/_source-status.tsx) import it, the
 * checks themselves stay on the server (./status.ts, GET /api/status).
 */

export interface DatabaseStatus {
  /** The canary id - a stable key the page hangs its icon on. */
  id: string;
  /** Display name of the database. */
  label: string;
  group: DatabaseGroup;
  /** Where a human can verify the source themselves. */
  href: string;
  ok: boolean | null;
  /** Epoch ms of the observation behind `ok`, null when unknown. */
  at: number | null;
  /** "kontrola" = canary, null = unknown. */
  via: "kontrola" | null;
  detail?: string;
}

/**
 * The headings the home page sorts the public databases under, in this order
 * (Slovensko = the slov-lex.sk sources, shown with the Slovak flag).
 * A "Pro" database (UKAŽ, switched on per account) is listed in the Pro group
 * instead, beside Vlastní soubory and Zotero (app/_zdroje/own-sources.tsx).
 */
export const DATABASE_GROUPS = ["Judikatura", "Předpisy", "Slovensko"] as const;
export type DatabaseGroup = (typeof DATABASE_GROUPS)[number] | "Pro";

/**
 * The courts the case-law mirror holds (src/sources/mirror.ts), by the
 * source id its /v1/status reports them under. The home page lists them
 * apart, as "Interní databáze", with how many decisions each holds.
 */
export type MirrorSourceId = "ns" | "nss" | "us" | "justice";

/** Decisions per mirrored court (GET /api/status/mirror); a court the mirror did not report is missing. */
export type MirrorCounts = Partial<Record<MirrorSourceId, number>>;

/**
 * The databases shown on the page, each tied to the SOURCE constant its
 * client reports under and to the probe canary that can stand in for it.
 */
export const DATABASES: Array<{
  label: string;
  group: DatabaseGroup;
  href: string;
  source: string;
  canaryId: string;
  /** Set for a court the case-law mirror holds. */
  mirror?: MirrorSourceId;
}> = [
  {
    label: "Nejvyšší soud",
    group: "Judikatura",
    href: "https://rozhodnuti.nsoud.cz",
    source: "Nejvyšší soud",
    canaryId: "ns",
    mirror: "ns",
  },
  {
    label: "Nejvyšší správní soud",
    group: "Judikatura",
    href: "https://vyhledavac.nssoud.cz",
    source: "Nejvyšší správní soud",
    canaryId: "nss",
    mirror: "nss",
  },
  {
    label: "Ústavní soud",
    group: "Judikatura",
    href: "https://nalus.usoud.cz",
    source: "Ústavní soud (NALUS)",
    canaryId: "nalus",
    mirror: "us",
  },
  {
    label: "Obecné soudy",
    group: "Judikatura",
    href: "https://rozhodnuti.justice.cz",
    source: "rozhodnuti.justice.cz",
    canaryId: "justice",
    mirror: "justice",
  },
  {
    label: "Soudní dvůr EU",
    group: "Judikatura",
    href: "https://infocuria.curia.europa.eu",
    source: "CJEU (InfoCuria)",
    canaryId: "curia",
  },
  {
    label: "e-Sbírka",
    group: "Předpisy",
    href: "https://www.e-sbirka.cz",
    source: "e-Sbírka",
    canaryId: "esbirka-api",
  },
  {
    label: "Poslanecká sněmovna",
    group: "Předpisy",
    href: "https://www.psp.cz/sqw/tisky.sqw",
    source: "Poslanecká sněmovna (psp.cz)",
    canaryId: "psp",
  },
  {
    label: "EUR-Lex",
    group: "Předpisy",
    href: "https://eur-lex.europa.eu",
    source: "EUR-Lex (Cellar)",
    canaryId: "cellar-sparql",
  },
  // The SOURCE strings are spelled out, not imported from slovlex-base: this
  // module goes to the browser (app/_source-status.tsx) and the clients do
  // network I/O. tests/slovlex-integration.test.ts pins them to the constants.
  {
    label: "Zbierka zákonov SR",
    group: "Slovensko",
    href: "https://www.slov-lex.sk/ezbierky",
    source: "Slov-Lex (Zbierka zákonov SR)",
    canaryId: "slovlex-zbierka",
  },
  {
    label: "eLegislatíva",
    group: "Slovensko",
    href: "https://www.slov-lex.sk/elegislativa",
    source: "Slov-Lex (eLegislatíva)",
    canaryId: "slovlex-lp",
  },
  {
    label: "Súdne rozhodnutia SR",
    group: "Slovensko",
    href: "https://www.slov-lex.sk/sudne-rozhodnutia",
    source: "Slov-Lex (súdne rozhodnutia)",
    canaryId: "slovlex-sudy",
  },
  {
    label: "UKAŽ",
    group: "Pro",
    href: "https://cuni.primo.exlibrisgroup.com/discovery/search?vid=420CKIS_INST:UKAZ",
    source: "UKAŽ (Univerzita Karlova, Primo)",
    canaryId: "primo",
  },
];

/** "14:07" in Prague time - what the light is as of. */
export function formatTime(at: number): string {
  return new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Prague",
  }).format(new Date(at));
}
