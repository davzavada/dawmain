/**
 * Normalization every DMD string goes through — in the browser after
 * conversion AND on the server before parsing (the server never trusts the
 * client's normalization). Isomorphic and pure.
 *
 * Besides hygiene (NFC, line ends) it closes two injection paths:
 * - bidi and zero-width characters, which can make text read differently
 *   to a human than to a model;
 * - the reserved brackets ⟦ ⟧ that tool output uses for page markers,
 *   footnotes and the untrusted-content fence. Removing them from every
 *   input means a document can never forge a marker or close the fence.
 */

// C0 controls except \n (tab is handled separately), DEL, C1 controls.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Bidi controls and marks.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
// Zero-width characters and the soft hyphen (a line-break hint, never content).
const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
const RESERVED_OPEN = /⟦/g; // ⟦
const RESERVED_CLOSE = /⟧/g; // ⟧

export function normalizeDmd(input: string): { text: string; changed: boolean } {
  const text = input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROLS, "")
    .replace(BIDI, "")
    .replace(ZERO_WIDTH, "")
    .replace(RESERVED_OPEN, "[")
    .replace(RESERVED_CLOSE, "]");
  return { text, changed: text !== input };
}

/**
 * One line of document-derived text for tool prose or UI (a title, heading,
 * author, page label): normalized, whitespace collapsed, backticks and the
 * reserved brackets removed, capped with an ellipsis. Pure.
 */
export function sanitizeLine(input: string, max = 120): string {
  const { text } = normalizeDmd(input ?? "");
  const line = text.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, Math.max(1, max - 1));
  // Never split a surrogate pair.
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${safe.trimEnd()}…`;
}
