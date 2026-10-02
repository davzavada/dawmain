/**
 * The databases the home page lists, with the shape of their status and the
 * time format the badges use. Pure data and formatting, no I/O: the client
 * components that render the badges (app/_source-status.tsx) import it, the
 * checks themselves stay on the server (./status.ts, GET /api/status/[id]).
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
  /** "provoz" = seen on a real call, "kontrola" = canary, null = unknown. */
  via: "provoz" | "kontrola" | null;
  detail?: string;
}

/** The headings the home page sorts the databases under, in this order. */
export const DATABASE_GROUPS = ["Judikatura", "Předpisy", "Literatura"] as const;
export type DatabaseGroup = (typeof DATABASE_GROUPS)[number];

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
}> = [
  {
    label: "Nejvyšší soud",
    group: "Judikatura",
    href: "https://rozhodnuti.nsoud.cz",
    source: "Nejvyšší soud",
    canaryId: "ns",
  },
  {
    label: "Nejvyšší správní soud",
    group: "Judikatura",
    href: "https://vyhledavac.nssoud.cz",
    source: "Nejvyšší správní soud",
    canaryId: "nss",
  },
  {
    label: "Ústavní soud",
    group: "Judikatura",
    href: "https://nalus.usoud.cz",
    source: "Ústavní soud (NALUS)",
    canaryId: "nalus",
  },
  {
    label: "Obecné soudy",
    group: "Judikatura",
    href: "https://rozhodnuti.justice.cz",
    source: "rozhodnuti.justice.cz",
    canaryId: "justice",
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
    label: "EUR-Lex",
    group: "Předpisy",
    href: "https://eur-lex.europa.eu",
    source: "EUR-Lex (Cellar)",
    canaryId: "cellar-sparql",
  },
  {
    label: "UKAŽ",
    group: "Literatura",
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
