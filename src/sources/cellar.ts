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
      // parallel (order preserved by Promise.all) and concat.
      const listing = await response.text();
      const parts = [...listing.matchAll(/href="(http[^"]+)"/g)].map((m) => m[1]).slice(0, 10);
      if (!parts.length) return null;
      const texts = (
        await Promise.all(
          parts.map(async (part) => {
            const partResponse = await fetchUpstream(source, part, {
              headers: { accept: "application/xhtml+xml, text/html", "accept-language": lang },
              timeoutMs: 25_000,
            });
            return partResponse.ok ? htmlToText(await partResponse.text()) : "";
          }),
        )
      ).filter(Boolean);
      return texts.join("\n\n") || null;
    }
    if (!response.ok) return null;
    const text = htmlToText(await response.text());
    return text.length > 200 ? text : null;
  };

  const text = (await attempt(lang3)) ?? (lang3 !== "eng" ? await attempt("eng") : null);
  // Cache only hits — a null can be a transient upstream miss.
  if (text) textCache.set(key, text);
  return text;
}
