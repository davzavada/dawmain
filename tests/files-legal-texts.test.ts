import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The public texts make promises that hang on code: who processes what, how
 * a page is billed, what the Zotero key may do. These tests
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

// The pages as they render the repository's own wording (the defaults of the
// editable texts) — what an admin stores on /sprava/texty is theirs to keep true.
const { PrivacyPage, TermsPage } = await import("@/app/_legal-pages");
const { DEFAULT_TEXTS } = await import("@/src/content/texts");
const { SiteNav } = await import("@/app/_nav");
const { CONTACT, EFFECTIVE } = await import("@/app/_legal");
const { LIMITS } = await import("@/src/files/config");
const { USAGE_KEEP_DAYS } = await import("@/src/files/db/usage");

/** Rendered page as plain text, whitespace collapsed (JSX line breaks vary). */
function text(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const privacy = text(createElement(PrivacyPage, { texts: DEFAULT_TEXTS }));
const terms = text(createElement(TermsPage, { texts: DEFAULT_TEXTS }));

describe("privacy policy (/soukromi)", () => {
  it("names the operator as controller, with no processing contract for uploads", () => {
    expect(privacy).toContain("David Závada");
    expect(privacy).toContain(CONTACT);
    expect(privacy).not.toContain("jen jako zpracovatel");
    expect(terms).not.toContain("čl. 28 GDPR");
  });

  it("names every processor, and only those", () => {
    for (const processor of ["Clerk, Inc.", "Cloudflare, Inc."]) {
      expect(privacy).toContain(processor);
    }
    expect(privacy).toContain("Clerk i Cloudflare jsou americké společnosti");
    expect(privacy).toContain("tito zpracovatelé");
    expect(privacy).toContain("na mém vlastním serveru v České republice");
    // No former host is named as a processor any more.
    expect(privacy).not.toContain("Neon");
    expect(privacy).not.toContain("hosting (Frankfurt)");
    // The AI metadata proposal is gone, and with it Vercel (AI Gateway) and Google (Gemini).
    for (const page of [privacy, terms]) {
      expect(page).not.toMatch(/Vercel|Gemini|AI Gateway|jazykov\S* model/);
    }
  });

  it("states the retention the code applies", () => {
    expect(USAGE_KEEP_DAYS).toBe(365);
    expect(privacy).toContain("počty volání u účtu nejdéle 12 měsíců");
    // Webhook / cron mark a library for purge 6 days out; the daily run adds at most a day.
    expect(privacy).toContain("nejdéle však do zrušení účtu nebo odebrání Pro. Pak knihovnu do týdne smažu");
    expect(privacy).not.toContain("nejdéle 6 hodin");
    expect(privacy).toContain("Databázi zatím pravidelně nezálohuji");
    expect(privacy).not.toContain("90 dní");
    expect(terms).not.toContain("90 dní");
    expect(privacy).toContain("dokud Zotero neodpojíte nebo nezrušíte účet");
  });

  it("uses only sign-in cookies and stores the Zotero key encrypted", () => {
    expect(privacy).toContain("jen cookies nezbytné pro přihlášení");
    expect(privacy).toContain("zašifrovaný klíč k vaší knihovně");
  });

  it("discloses the internal usage overview, not for marketing", () => {
    expect(privacy).toContain("kdo službu používá, jak často a které nástroje");
    expect(privacy).toContain("k marketingu ho nepoužívám");
  });

  it("states which data are required and which are voluntary (čl. 13 odst. 2 písm. e))", () => {
    expect(privacy).toContain("bez nich účet nelze vytvořit");
    expect(privacy).toContain("Nahrávání dokumentů a připojení Zotera jsou dobrovolné");
  });

  it("gives every row a period, keeps no purge record and names no IP address the server never stores", () => {
    expect(privacy).toContain("identifikátor účtu oprávněný zájem ( čl. 6 odst. 1 písm. f) GDPR ) 30 dní");
    expect(privacy).not.toContain("po dobu potřebnou");
    expect(privacy).not.toContain("Doložení výmazu");
    expect(privacy).toContain("Po výmazu si nenechávám nic, ani záznam o něm");
    expect(privacy).toContain("(řádky 2, 3 a 5)");
  });

  it("sends the text to no AI provider", () => {
    expect(privacy).toContain("Text nahraných dokumentů žádnému poskytovateli AI neposílám.");
    // …which does not cover the user's own assistant: it gets what the tools return.
    expect(privacy).toContain("dostane poskytovatel asistenta, kterého používáte");
  });

  it("says the Czech case law is copied as the courts publish it", () => {
    expect(privacy).toContain("kopíruji je tak, jak jsou zveřejněná");
    expect(privacy).toContain("anonymizovaná");
  });

  it("has no DPO section", () => {
    expect(privacy).not.toContain("Pověřenec");
  });

  it("shows the shared effective date", () => {
    expect(EFFECTIVE).toMatch(/^\d{1,2}\. \d{1,2}\. \d{4}$/);
    expect(privacy).toContain(`Účinné od ${EFFECTIVE}`);
  });
});

describe("Zotero in the terms", () => {
  it("states the user's choice of key: read only, or read and save new records — never changing or deleting", () => {
    expect(terms).toContain("Zotero (Pro)");
    expect(terms).toContain("jen číst , nebo číst a ukládat");
    expect(terms).toContain("Stávající záznamy Dawmain nikdy nemění ani nemaže a do skupin nezapisuje");
  });
});

describe("terms of use (/podminky)", () => {
  it("keeps the existing sections and adds Vlastní soubory (Pro)", () => {
    for (const heading of ["Účet a slušné užívání", "Vlastní soubory (Pro)", "Ukončení a změny"]) {
      expect(terms).toContain(heading);
    }
    expect(terms).toContain(`Účinné od ${EFFECTIVE}`);
  });

  it("says who sees team files and how long they are kept", () => {
    expect(terms).toContain("dokumenty nahrané do ní vidí a prohledávají všichni jeho členové");
    expect(terms).toContain("Členy týmů přiděluji a měním já.");
    expect(privacy).toContain("Dokumenty nahrané do týmové knihovny vidí členové toho týmu.");
    expect(privacy).toContain("Týmové dokumenty smažu do týdne po vypnutí nebo zrušení týmu.");
  });

  it("states the storage quotas the code defaults to (originals, MB)", () => {
    expect(LIMITS.personalBytes).toBe(100 * 1024 * 1024);
    expect(LIMITS.teamBytes).toBe(1024 * 1024 * 1024);
    expect(LIMITS.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(terms).toContain("osobní knihovna má 100 MB, týmová 1 GB a jeden soubor může mít nejvýš 100 MB");
  });

  it("asks the uploader to keep the section's rules", () => {
    expect(terms).toContain("Nahráním dokumentu potvrzujete, že pravidla v tomto oddílu dodržíte");
  });

  it("says the server proposes the metadata, which may be wrong and can be corrected, and that there is no backup", () => {
    expect(terms).toContain("metadata navrhne server podle začátku dokumentu a asistent");
    expect(terms).toContain("po rozkliknutí dokumentu v seznamu souborů ho kdykoli opravíte");
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

  it("says originals are stored, not backed up, and can be downloaded with the text", () => {
    expect(terms).toContain("Server ukládá nahraný soubor i jeho převedený text");
    expect(terms).toContain("Originál i text si můžete kdykoli stáhnout na stránce souborů");
    expect(privacy).toContain("soubory, které nahrajete (originál i převedený text)");
  });
});

describe("site navigation", () => {
  afterEach(() => {
    pathname = "/";
  });

  it("has no Vlastní zdroje item any more: the home page's group opens the modal", () => {
    for (const at of ["/", "/sprava", "/soukromi"]) {
      pathname = at;
      const html = renderToStaticMarkup(createElement(SiteNav, { sourceCount: 8 }));
      expect(html).not.toContain('href="/vlastni-zdroje"');
      expect(html).not.toContain("zd-nav-locked");
      expect(html).not.toContain("placené verzi");
    }
  });
});
