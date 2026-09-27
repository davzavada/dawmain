/**
 * Fixture loader for the metadata tests: a realistic Czech document as DMD
 * (tests/fixtures/files/meta/*.dmd) → normalized → parsed → MetaInput, the
 * same path ingest takes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import type { ParsedDoc } from "@/src/files/dmd/types";
import { buildMetaInput, type MetaInput } from "@/src/files/meta/input";
import type { DocType, UploadHints } from "@/src/files/types";

export const META_FIXTURE_NAMES = [
  "komentar-beck",
  "komentar-wk",
  "clanek-pr",
  "clanek-auc",
  "kniha-leges",
  "vzor-kupni-smlouva",
  "rozhodnuti-ns",
  "rozhodnuti-us",
] as const;
export type MetaFixture = (typeof META_FIXTURE_NAMES)[number];

/** Running heads the PDF converter would have removed from the article's pages. */
export const PR_RUNNING_HEADS: UploadHints["running_heads"] = [
  { page: 1, text: "Právní rozhledy 12/2023" },
  { page: 1, text: "417" },
  { page: 2, text: "Právní rozhledy 12/2023" },
  { page: 2, text: "418" },
  { page: 2, text: "Nováková: Odpovědnost za škodu způsobenou systémy umělé inteligence" },
  { page: 3, text: "ČLÁNKY" },
  { page: 3, text: "Právní rozhledy 12/2023" },
];

export function fixtureText(name: string): string {
  return normalizeDmd(readFileSync(path.join(__dirname, `${name}.dmd`), "utf8")).text;
}

export function parseFixture(name: string): ParsedDoc {
  return parseDmd(fixtureText(name));
}

export function fixtureInput(name: MetaFixture, opts: { hints?: UploadHints; docTypeHint?: DocType | null; fileName?: string } = {}): MetaInput {
  const hints = opts.hints ?? (name === "clanek-pr" ? { running_heads: PR_RUNNING_HEADS } : {});
  return buildMetaInput(parseFixture(name), hints, opts.fileName ?? `${name}.pdf`, opts.docTypeHint ?? null);
}
