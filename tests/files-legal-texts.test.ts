import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The public texts make promises that hang on code: who processes what, how
 * a page is billed, where Vlastní zdroje live in the navigation. These tests
 * render the real pages and pin those promises to the constants they depend
 * on, so changing the code without the text (or the text without the code)
 * fails here instead of on the live site.
 */

// Next's Link and router hooks need the framework; a plain anchor and a
// settable pathname are all these pages use of them.
let pathname = "/";
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { default: Soukromi } = await import("@/app/soukromi/page");
const { default: Podminky } = await import("@/app/podminky/page");
const { SiteNav } = await import("@/app/_nav");
const { CONTACT, EFFECTIVE } = await import("@/app/_legal");
const { PAGE_CHARS, metaModel } = await import("@/src/files/config");
const { READ_COUNTER_KEEP_DAYS, USAGE_KEEP_DAYS } = await import("@/src/files/db/usage");

/** Rendered page as plain text, whitespace collapsed (JSX line breaks vary). */
function text(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const privacy = text(createElement(Soukromi));
const terms = text(createElement(Podminky));

describe("privacy policy (/soukromi)", () => {
  it("drops the claims that uploads made false", () => {
    for (const stale of [
      "Vlastní databázi nevedu",
      "nic si trvale neukládám",
      "Vaše rešerše Evropskou unii neopouští",
      "nenastavují žádné cookies",
      "Nejvíc ale chrání to, co tu vůbec není",
      "dva zpracovatelé",
    ]) {
      expect(privacy).not.toContain(stale);
    }
  });

  it("names every processor of uploaded content", () => {
    for (const processor of ["Clerk, Inc.", "Vercel, Inc.", "Neon, Inc.", "AI Gateway", "Google"]) {
      expect(privacy).toContain(processor);
    }
    expect(privacy).toContain("tři zpracovatelé");
  });

  it("names the provider of the configured metadata model", () => {
    // The page discloses Google (Gemini) as Vercel's sub-processor. A model
    // from another provider is a new sub-processor: update /soukromi first.
    const saved = process.env.FILES_META_MODEL;
    delete process.env.FILES_META_MODEL;
    try {
      expect(metaModel()).toMatch(/^google\/gemini-/);
    } finally {
      if (saved !== undefined) process.env.FILES_META_MODEL = saved;
    }
    expect(privacy).toContain("Gemini");
  });

  it("states that originals stay on the device and only text is uploaded", () => {
    expect(privacy).toContain("původní soubor vaše zařízení neopustí");
    expect(privacy).toContain("originály sem vůbec nepřijdou");
  });

  it("keeps the EU promise for official sources and states the exception", () => {
    expect(privacy).toContain("Rešerše v oficiálních zdrojích Evropskou unii neopouští");
    expect(privacy).toContain("část textu dokumentu k návrhu metadat");
  });

  it("states retention for uploads, deletion and revoked Pro", () => {
    expect(privacy).toContain("nejdéle 6 hodin");
    expect(privacy).toContain("nejpozději do 8 dnů");
    expect(privacy).toContain("90 dní");
    // The daily cron drops the text of a failed upload after 7 days (PENDING_KEEP_DAYS).
    expect(privacy).toContain("text dokumentu, který se nepodařilo zpracovat - 7 dní");
  });

  it("states the retention the daily cron applies to counters and audit rows", () => {
    // pruneUsage: per-user read/export counters (read:<user>:…) and the rest of usage_daily.
    // Today's and yesterday's rows (day >= today - 1): two UTC days, as the notice says.
    expect(READ_COUNTER_KEEP_DAYS).toBe(1);
    expect(privacy).toContain("denní počítadla čtení a stažení - 2 dny");
    expect(USAGE_KEEP_DAYS).toBe(365);
    expect(privacy).toContain("nejdéle 12 měsíců");
    // files_forget_purged_audit keeps only the purge record (library id, date, count).
    expect(privacy).toContain("zůstane jen její interní označení a záznam, kdy a kolik dokumentů");
  });

  it("points to the self-service text export (web: GET /api/files/documents/[id]/export)", () => {
    expect(privacy).toContain("„Exportovat text“ v detailu dokumentu");
    expect(privacy).toMatch(/90 dní ji uvidíte na webu, můžete dokumenty mazat a jejich text s metadaty si stáhnout/);
    expect(privacy).not.toContain("na požádání vám pošlu jejich text");
  });

  it("says the AI Gateway gets a pseudonym, not the account (userHash)", () => {
    expect(privacy).toContain("dostane jen pseudonym");
  });

  it("describes the sign-in cookies as strictly necessary", () => {
    expect(privacy).toContain("__session");
    expect(privacy).toContain("__client_uat");
    expect(privacy).toContain("jsou tedy nezbytné");
  });

  it("makes the uploader the controller of personal data in uploads", () => {
    expect(privacy).toContain("Jejich správcem jste vy");
    expect(privacy).toContain("jen jako zpracovatel");
  });

  it("shows the shared effective date", () => {
    expect(EFFECTIVE).toMatch(/^\d{1,2}\. \d{1,2}\. \d{4}$/);
    expect(privacy).toContain(`Účinné od ${EFFECTIVE}`);
  });
});

describe("terms of use (/podminky)", () => {
  it("keeps the existing sections and adds Vlastní zdroje (Pro)", () => {
    for (const heading of ["Účet a slušné užívání", "Vlastní zdroje (Pro)", "Ukončení a změny"]) {
      expect(terms).toContain(heading);
    }
    expect(terms).toContain(`Účinné od ${EFFECTIVE}`);
  });

  it("bills pages by the same character count as the code", () => {
    const formatted = PAGE_CHARS.toLocaleString("cs-CZ").replace(/\s/g, " ");
    expect(terms.replace(/\s/g, " ")).toContain(`${formatted} znaků`);
  });

  it("states the content rules, the uploader's warranty and the forbidden content", () => {
    expect(terms).toContain("Nahráním potvrzujete, že tato práva máte");
    for (const rule of [
      "beck-online, ASPI, Codexis",
      "spisy a dokumenty klientů",
      "čl. 9 a 10 GDPR",
      "obchodní tajemství jiných",
      "bez osobních údajů klientů",
    ]) {
      expect(terms).toContain(rule);
    }
  });

  it("says AI only proposes metadata and that there is no backup", () => {
    expect(terms).toContain("Je to jen návrh");
    expect(terms).toContain("Záloha není");
  });

  it("gives a notice-and-action contact and the law-enforcement policy", () => {
    expect(terms).toContain("Nezákonný obsah");
    expect(terms).toContain(CONTACT);
    expect(terms).toContain("pokud mi to zákon nezakazuje");
  });

  it("designates the DSA single point of contact and its languages (arts. 11 and 12)", () => {
    const at = terms.indexOf("Kontaktní místo.");
    expect(at).toBeGreaterThan(-1);
    const paragraph = terms.slice(at, at + 500);
    expect(paragraph).toContain("čl. 11 nařízení (EU) 2022/2065");
    expect(paragraph).toContain("(čl. 12)");
    expect(paragraph).toContain(CONTACT);
    expect(paragraph).toContain("česky nebo anglicky");
  });

  it("keeps the text export open after Pro is revoked and names it next to the no-backup rule", () => {
    expect(terms).toContain("90 dní k prohlížení, mazání a stažení textu");
    expect(terms).toContain("„Exportovat text“");
  });
});

describe("site navigation", () => {
  afterEach(() => {
    pathname = "/";
  });

  function ownSourcesLinks(html: string): string[] {
    return html.match(/<a[^>]*href="\/vlastni-zdroje"[^>]*>.*?<\/a>/g) ?? [];
  }

  it("links Vlastní zdroje from the sidebar and the tab strip, locked for visitors (design 1a)", () => {
    const html = renderToStaticMarkup(createElement(SiteNav, { sourceCount: 8 }));
    const links = ownSourcesLinks(html);
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toContain('title="Vlastní zdroje — v režimu Pro, přiděluji zdarma"');
      expect(link).toContain("zd-nav-locked");
      expect(link).toContain("zd-nav-lock");
      expect(link).not.toContain("pro-pill");
      expect(link).not.toContain("aria-current");
      expect(link).not.toContain("aria-disabled");
    }
    expect(links[0]).toContain("Nahrát vlastní zdroje");
    expect(links[1]).toContain(">Vlastní zdroje<");
    expect(html).not.toContain("placené verzi");
  });

  it("marks Vlastní zdroje current on its pages only", () => {
    pathname = "/vlastni-zdroje/provoz";
    const inside = ownSourcesLinks(renderToStaticMarkup(createElement(SiteNav, { sourceCount: 8 })));
    expect(inside).toHaveLength(2);
    for (const link of inside) expect(link).toContain('aria-current="location"');

    pathname = "/vlastni-zdroje";
    const root = ownSourcesLinks(renderToStaticMarkup(createElement(SiteNav, { sourceCount: 8 })));
    for (const link of root) expect(link).toContain('aria-current="location"');

    // Segment-aware: a route that merely shares the prefix is not inside.
    pathname = "/vlastni-zdrojeX";
    const lookalike = ownSourcesLinks(
      renderToStaticMarkup(createElement(SiteNav, { sourceCount: 8 })),
    );
    expect(lookalike).toHaveLength(2);
    for (const link of lookalike) expect(link).not.toContain("aria-current");

    pathname = "/soukromi";
    const elsewhere = ownSourcesLinks(
      renderToStaticMarkup(createElement(SiteNav, { sourceCount: 8 })),
    );
    for (const link of elsewhere) expect(link).not.toContain("aria-current");
  });
});
