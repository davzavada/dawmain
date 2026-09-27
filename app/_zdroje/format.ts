import type { DocStatus, FileKind } from "@/src/files/types";

/**
 * Czech formatting for the Vlastní zdroje UI: plurals, sizes, dates,
 * status badges, initials. Pure — unit-tested (tests/files-web-format.test.ts);
 * safe in server and client components.
 */

/** Czech plural: 1 → one, 2–4 → few, 0 and 5+ → many (so are negatives and fractions). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (Number.isInteger(n) && n >= 2 && n <= 4) return few;
  return many;
}

/** Thousands with a narrow no-break space, as Czech typography writes them: 1 240. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return n < 0 ? `−${s}` : s;
}

/** "1 dokument", "3 dokumenty", "12 dokumentů". */
export function countDocuments(n: number): string {
  return `${formatCount(n)} ${plural(n, "dokument", "dokumenty", "dokumentů")}`;
}

/** "1 člen", "3 členové", "5 členů". */
export function countMembers(n: number): string {
  return `${formatCount(n)} ${plural(n, "člen", "členové", "členů")}`;
}

/** "1 strana", "3 strany", "1 240 stran". */
export function countPages(n: number): string {
  return `${formatCount(n)} ${plural(n, "strana", "strany", "stran")}`;
}

/** "2 zapnuté dokumenty z 4" (the home page's Moje zdroje row). */
export function enabledOf(enabled: number, total: number): string {
  return `${formatCount(enabled)} ${plural(enabled, "zapnutý dokument", "zapnuté dokumenty", "zapnutých dokumentů")} z ${formatCount(total)}`;
}

/**
 * File size the way the design writes it — decimal units, Czech comma:
 * "512 B", "180 kB", "2,4 MB", "14,8 MB", "120 MB", "1,2 GB". One decimal
 * below 100 MB/GB, whole kilobytes. Empty for no size.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const kb = Math.round(bytes / 1_000);
  if (kb < 1_000) return `${kb} kB`;
  const big = (v: number, unit: string) => {
    const rounded = v < 100 ? Math.round(v * 10) / 10 : Math.round(v);
    return `${String(rounded).replace(".", ",")} ${unit}`;
  };
  const mb = bytes / 1e6;
  if (Math.round(mb * 10) / 10 < 1_000) return big(mb, "MB");
  return big(bytes / 1e9, "GB");
}

/** The Czech date "12. 9. 2026" (Prague time); "dnes" / "včera" for recent ones. */
export function formatDate(iso: string | number | Date, now: Date = new Date()): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => x.toLocaleDateString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric" });
  const today = day(now);
  if (day(d) === today) return "dnes";
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return "včera";
  // toLocaleDateString gives "12. 9. 2026" in cs-CZ; normalise the spaces in case an engine uses NBSP.
  return day(d).replace(/\s+/g, " ");
}

/** "PDF", "DOCX", "TXT", "MD". */
export function kindLabel(kind: FileKind | string): string {
  return String(kind).toUpperCase();
}

export type Tone = "ok" | "busy" | "info" | "bad" | "neutral";

/** Status badge of a document: label and colour (design 2b: Připraveno / Zpracovává se… / Ke kontrole / Nelze přečíst / Chyba). */
export function statusBadge(status: DocStatus, detail?: string | null): { label: string; tone: Tone } {
  switch (status) {
    case "ready":
      return { label: "Připraveno", tone: "ok" };
    case "queued":
    case "processing":
      return { label: "Zpracovává se…", tone: "busy" };
    case "review":
      return { label: "Ke kontrole", tone: "info" };
    case "error":
      // A text the server could not read (scan, broken text) vs. a failure of ours.
      return /sken|poškozen|neobsahuje|nelze|limit/i.test(detail ?? "") ? { label: "Nelze přečíst", tone: "bad" } : { label: "Chyba", tone: "bad" };
    default:
      return { label: "Maže se…", tone: "neutral" };
  }
}

/**
 * One badge summarising a library for the home page row: processing wins
 * (something is moving), then review (the user has work), then ready.
 * Null for an empty library.
 */
export function libraryBadge(counts: { total: number; processing: number; review: number; ready: number } | null): { label: string; tone: Tone } | null {
  if (!counts || counts.total === 0) return null;
  if (counts.processing > 0) return { label: "zpracovává se", tone: "busy" };
  if (counts.review > 0) return { label: "ke kontrole", tone: "info" };
  if (counts.ready > 0) return { label: "připraveno", tone: "ok" };
  return { label: "chyba", tone: "bad" };
}

/** "DZ" from "David Závada"; one letter for one word; "?" for nothing usable. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "")
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Avatar colours of the design (indigo, teal, rose, amber, green); stable per id. */
const AVATAR_COLORS = ["#372fa2", "#0f766e", "#be123c", "#b45309", "#15803d", "#1d4ed8"];

export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Footer line of the modal: "4 dokumenty · 1 240 z 3 000 stran". */
export function quotaLine(documents: number, pagesUsed: number, quotaPages: number): string {
  return `${countDocuments(documents)} · ${formatCount(pagesUsed)} z ${formatCount(quotaPages)} ${plural(quotaPages, "strany", "stran", "stran")}`;
}

/** Share of the quota for the progress bar, 0–1, with a visible minimum for a non-empty library. */
export function quotaShare(used: number, quota: number): number {
  if (!(quota > 0) || !(used > 0)) return 0;
  return Math.min(1, Math.max(0.01, used / quota));
}
