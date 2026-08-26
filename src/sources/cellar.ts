import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";
import { DOCUMENT_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * Cellar — the EU Publications Office dissemination API (official, keyless).
 * One retrieval surface serves both EUR-Lex legislation and CJEU case law:
 *   GET /resource/celex/{CELEX}   GET /resource/ecli/{ECLI}
 * with Accept: application/xhtml+xml, text/html and a 3-letter (ISO 639-2/T)
 * Accept-Language. HTTP 300 = multi-part document listing sibling part URLs.
 */

export const CELLAR_BASE = "https://publications.europa.eu/resource";

/** Tool language input (cs/en/…) → Cellar's 3-letter ISO 639-2/T codes. */
export const CELLAR_LANGS: Record<string, string> = {
  cs: "ces",
  en: "eng",
  de: "deu",
  fr: "fra",
  sk: "slk",
  pl: "pol",
  es: "spa",
  it: "ita",
};

/** Texts are big — keep the entry count low; the TTL bounds memory, not staleness. */
const textCache = new TtlCache<string>(DOCUMENT_TTL_MS, 24);
/** Multi-part cap: raised well above anything seen in practice, with an
 * explicit truncation marker when a document still exceeds it. */
const PART_CAP = 20;

export async function fetchCellarText(
  source: string,
  path: string,
  language: string,
): Promise<string | null> {
  const lang3 = CELLAR_LANGS[language.toLowerCase()] ?? "eng";
  const key = memoKey("cellar", [path, lang3]);
  const cached = textCache.get(key);
  if (cached !== undefined) return cached;

  const attempt = async (lang: string): Promise<string | null> => {
    const response = await fetchUpstream(source, `${CELLAR_BASE}${path}`, {
      headers: {
        accept: "application/xhtml+xml, text/html",
        "accept-language": lang,
      },
      timeoutMs: 25_000,
    });
    if (response.status === 300) {
      // Multi-part document: the body lists sibling part URLs — fetch in
      // parallel (order preserved by Promise.all) and concat. A failed part
      // fails the WHOLE retrieval: silently joining around a hole would
      // present a judgment with a missing middle as complete text.
      const listing = await response.text();
      // These URLs come out of a RESPONSE BODY — the only such fetch targets in
      // the codebase. Keep them on Cellar's own origin so a doctored listing
      // cannot make the deployment fetch (and echo back) arbitrary addresses.
      const cellarOrigin = new URL(CELLAR_BASE).origin;
      const allParts = [...listing.matchAll(/href="(http[^"]+)"/g)]
        .map((m) => m[1])
        .filter((href) => {
          try {
            return new URL(href).origin === cellarOrigin;
          } catch {
            return false;
          }
        });
      const parts = allParts.slice(0, PART_CAP);
      if (!parts.length) return null;
      const texts = await Promise.all(
        parts.map(async (part) => {
          const partResponse = await fetchUpstream(source, part, {
            headers: { accept: "application/xhtml+xml, text/html", "accept-language": lang },
            timeoutMs: 25_000,
          });
          return partResponse.ok ? htmlToText(await partResponse.text()) : null;
        }),
      );
      if (texts.some((text) => text === null)) return null;
      const joined = texts.filter(Boolean).join("\n\n");
      if (!joined) return null;
      return allParts.length > PART_CAP
        ? `${joined}\n\n[Document truncated: only the first ${PART_CAP} of ${allParts.length} parts were retrieved.]`
        : joined;
    }
    if (!response.ok) return null;
    const text = htmlToText(await response.text());
    return text.length > 200 ? text : null;
  };

  const primary = await attempt(lang3);
  if (primary) {
    textCache.set(key, primary);
    return primary;
  }
  // English fallback: cache under the language that actually served it, so a
  // transient failure of e.g. the cs rendition does not pin English text to
  // the cs key for the whole TTL. (Nulls are never cached — could be transient.)
  if (lang3 === "eng") return null;
  const fallback = await attempt("eng");
  if (fallback) textCache.set(memoKey("cellar", [path, "eng"]), fallback);
  return fallback;
}
