import { describe, expect, it } from "vitest";
import {
  avatarColor,
  countDocuments,
  countMembers,
  countPages,
  countPagesAcc,
  downloadFileName,
  enabledOf,
  formatBytes,
  formatCount,
  formatDate,
  initials,
  kindLabel,
  libraryBadge,
  plural,
  quotaLine,
  quotaShare,
  statusBadge,
} from "@/app/_zdroje/format";
import { metaLine, nextPollDelay } from "@/app/_zdroje/list";
import { actInput, czechDate, fieldsFor, formFromMeta, payloadFromForm, proposalBadge, splitFields } from "@/app/_zdroje/meta-form";
import { buildUploadMeta, gzipText, missingBrowserFeatures, sha256Text, uploadCost, uploadForm, uploadOutcome } from "@/app/_zdroje/upload-core";
import { parseDmd } from "@/src/files/dmd/parse";
import { bibMetaBaseSchema, bibMetaSchema } from "@/src/files/meta/schema";
import { displayName, mapInvitations, mapMembers, normalizeEmail } from "@/src/files/team";
import { DOC_TYPES, type BibMeta } from "@/src/files/types";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

/**
 * Pure helpers of the Vlastní zdroje UI: Czech formatting and plurals,
 * status badges, the upload's cost / meta / gzip / refusal messages, the
 * page strip, the metadata form's shape (round-tripped through the
 * server's bibMetaSchema), and the team mapping.
 */

describe("Czech formatting", () => {
  it("plurals: 1 / 2–4 / 0 and 5+", () => {
    expect([0, 1, 2, 4, 5, 11, 22, 1.5, -1].map((n) => plural(n, "a", "b", "c"))).toEqual(["c", "a", "b", "b", "c", "c", "c", "c", "c"]);
    expect(countDocuments(1)).toBe("1 dokument");
    expect(countDocuments(2)).toBe("2 dokumenty");
    expect(countDocuments(4)).toBe("4 dokumenty");
    expect(countDocuments(5)).toBe("5 dokumentů");
    expect(countDocuments(0)).toBe("0 dokumentů");
    expect(countMembers(5)).toBe("5 členů");
    expect(countMembers(3)).toBe("3 členové");
    expect(countPages(1)).toBe("1 strana");
    expect(countPages(1240)).toBe("1 240 stran");
    expect(enabledOf(2, 4)).toBe("2 zapnuté dokumenty z 4");
    expect(enabledOf(1, 1)).toBe("1 zapnutý dokument z 1");
    expect(enabledOf(0, 7)).toBe("0 zapnutých dokumentů z 7");
  });

  it("counts with a narrow no-break space; garbage becomes 0", () => {
    expect(formatCount(3000)).toBe("3 000");
    expect(formatCount(1234567)).toBe("1 234 567");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(-1500)).toBe("−1 500");
    expect(formatCount(Number.NaN)).toBe("0");
  });

  it("file sizes as the design writes them", () => {
    expect(formatBytes(2_400_000)).toBe("2,4 MB");
    expect(formatBytes(180_000)).toBe("180 kB");
    expect(formatBytes(12_000)).toBe("12 kB");
    expect(formatBytes(14_800_000)).toBe("14,8 MB");
    expect(formatBytes(120_000_000)).toBe("120 MB");
    expect(formatBytes(999_999)).toBe("1 MB");
    expect(formatBytes(1_200_000_000)).toBe("1,2 GB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("dates: Czech, Prague time, dnes / včera", () => {
    const now = new Date("2026-09-27T10:00:00Z");
    expect(formatDate("2026-09-12T08:00:00Z", now)).toBe("12. 9. 2026");
    expect(formatDate("2026-09-27T06:00:00Z", now)).toBe("dnes");
    expect(formatDate("2026-09-26T12:00:00Z", now)).toBe("včera");
    // 23:30 UTC on the 26th is already the 27th in Prague.
    expect(formatDate("2026-09-26T23:30:00Z", now)).toBe("dnes");
    expect(formatDate(Date.UTC(2026, 0, 3), now)).toBe("3. 1. 2026");
    expect(formatDate("not a date", now)).toBe("");
  });

  it("status badges (design labels) and the library summary badge", () => {
    expect(statusBadge("ready")).toEqual({ label: "Připraveno", tone: "ok" });
    expect(statusBadge("queued")).toEqual({ label: "Zpracovává se…", tone: "busy" });
    expect(statusBadge("processing")).toEqual({ label: "Zpracovává se…", tone: "busy" });
    expect(statusBadge("review")).toEqual({ label: "Ke kontrole", tone: "info" });
    expect(statusBadge("error", "Dokument vypadá jako sken bez textové vrstvy")).toEqual({ label: "Nelze přečíst", tone: "bad" });
    expect(statusBadge("error", "Zpracování se nepodařilo, zkusíme to znovu.")).toEqual({ label: "Chyba", tone: "bad" });
    expect(statusBadge("error", null).label).toBe("Chyba");
    expect(statusBadge("deleting").tone).toBe("neutral");
    expect(libraryBadge(null)).toBeNull();
    expect(libraryBadge({ total: 0, processing: 0, review: 0, ready: 0 })).toBeNull();
    expect(libraryBadge({ total: 4, processing: 1, review: 1, ready: 2 })).toEqual({ label: "zpracovává se", tone: "busy" });
    expect(libraryBadge({ total: 4, processing: 0, review: 1, ready: 3 })?.label).toBe("ke kontrole");
    expect(libraryBadge({ total: 4, processing: 0, review: 0, ready: 4 })?.label).toBe("připraveno");
    expect(libraryBadge({ total: 1, processing: 0, review: 0, ready: 0 })?.label).toBe("chyba");
  });

  it("initials, avatar colours, kinds and the quota line", () => {
    expect(initials("David Závada")).toBe("DZ");
    expect(initials("jana.novakova@novak.cz")).toBe("JN");
    expect(initials("Čeněk")).toBe("Č");
    expect(initials("  ")).toBe("?");
    expect(initials(null)).toBe("?");
    expect(initials("Jan Amos Komenský")).toBe("JK");
    expect(avatarColor("user_a")).toBe(avatarColor("user_a"));
    expect(avatarColor("user_a")).toMatch(/^#[0-9a-f]{6}$/);
    expect(kindLabel("docx")).toBe("DOCX");
    expect(quotaLine(4, 1240, 3000)).toBe("4 dokumenty · 1 240 z 3 000 stran");
    expect(quotaShare(0, 3000)).toBe(0);
    expect(quotaShare(1, 3000)).toBe(0.01);
    expect(quotaShare(4000, 3000)).toBe(1);
    expect(quotaShare(10, 0)).toBe(0);
  });
});

describe("document list helpers", () => {
  it("polling backs off from 4 s to 15 s", () => {
    let d = 4_000;
    const seen = [d];
    for (let i = 0; i < 5; i++) seen.push((d = nextPollDelay(d)));
    expect(seen).toEqual([4_000, 6_000, 9_000, 13_500, 15_000, 15_000]);
    expect(nextPollDelay(0)).toBe(4_000);
  });

  it("the meta line: kind · size · date, with the uploader in a team", () => {
    const now = new Date("2026-09-27T10:00:00Z");
    const doc = { fileKind: "pdf" as const, fileBytes: 6_200_000, uploadedAt: "2026-09-19T09:00:00Z", uploaderName: "Jana Nováková" };
    expect(metaLine(doc, false, now)).toBe("PDF · 6,2 MB · 19. 9. 2026");
    expect(metaLine(doc, true, now)).toBe("PDF · 6,2 MB · Jana Nováková, 19. 9. 2026");
    expect(metaLine({ ...doc, fileBytes: null, uploaderName: null }, true, now)).toBe("PDF · 19. 9. 2026");
  });
});

// ---------------------------------------------------------------------------

const PAGED = ["[s. 417]", "", "# Úvod", "", "Text první strany s poznámkou[^1].", "", "[^1]: Poznámka.", "", "[s. 418]", "", "## § 2913", "", "[m. č. 1] Odstavec.", "", "[s. 419]", "", "## § 2914", "", "Konec."].join("\n");
const QUALITY = { footnotes: "linked" as const, linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 1, unsure_pages: [] };

describe("upload core", () => {
  it("the cost against the quota", () => {
    const parsed = parseDmd(PAGED);
    expect(uploadCost(parsed, 3000, 100)).toMatchObject({ pages: 1, remaining: 2900, fits: true });
    // Accusative after "zabere": 1 stranu, 2–4 strany, 5+ stran.
    expect(uploadCost(parsed, 3000, 100).line).toBe("Zabere 1 stranu z 2 900 zbývajících.");
    expect(uploadCost(parsed, 100, 100)).toMatchObject({ remaining: 0, fits: false });
    expect(uploadCost(parsed, 100, 500).remaining).toBe(0);
    // A new version of a document: its old pages are credited, as the server does (completeness:PC-2).
    expect(uploadCost(parsed, 100, 100, 5)).toMatchObject({ remaining: 5, fits: true });
    expect(uploadCost(parsed, 100, 100, 5).line).toBe("Zabere 1 stranu z 5 zbývajících (počítáno i s 5 stranami původní verze, která se nahradí).");
    expect(uploadCost(parsed, 100, 100, 1).line).toContain("s 1 stranou původní verze");
    expect(uploadCost(parsed, 100, 100, 0)).toMatchObject({ remaining: 0, fits: false });
  });

  it("UploadMeta for paged and unpaged documents", () => {
    const parsed = parseDmd(PAGED);
    const meta = buildUploadMeta({
      libraryId: "user_a",
      file: { name: "kniha.pdf", bytes: 1234.7, sha256: "c".repeat(64) },
      result: { kind: "pdf", converter: "pdf@1", quality: QUALITY, hints: {}, labelSource: "printed" },
      parsed,
      contentSha256: "d".repeat(64),
      rights: "licence",
      docTypeHint: "komentar",
      replaces: null,
    });
    expect(meta).toEqual({
      library_id: "user_a",
      file: { name: "kniha.pdf", bytes: 1234, sha256: "c".repeat(64), kind: "pdf" },
      converter: "pdf@1",
      content: { sha256: "d".repeat(64), chars: parsed.text.length },
      pages: { physical: 3, label_source: "printed" },
      quality: QUALITY,
      hints: {},
      rights: "licence",
      doc_type_hint: "komentar",
    });
    const plain = buildUploadMeta({
      libraryId: "org_t",
      file: { name: "vzor.docx", bytes: 10, sha256: "c".repeat(64) },
      result: { kind: "docx", converter: "docx@1", quality: QUALITY, hints: {}, labelSource: "none" },
      parsed: parseDmd("Text."),
      contentSha256: "d".repeat(64),
      rights: "vlastni",
      docTypeHint: null,
      replaces: "00000000-0000-4000-8000-000000000001",
    });
    expect(plain.pages).toBeUndefined();
    expect(plain.doc_type_hint).toBeUndefined();
    expect(plain.replaces).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("gzip and SHA-256 of the UTF-8 text match what the server recomputes", async () => {
    const text = "Příliš žluťoučký kůň — § 2913 ⟦x⟧ 😀\n".repeat(50);
    const gz = await gzipText(text);
    const raw = gunzipSync(Buffer.from(await gz.arrayBuffer()));
    expect(raw.toString("utf8")).toBe(text);
    expect(await sha256Text(text)).toBe(createHash("sha256").update(raw).digest("hex"));
    const body = uploadForm({ library_id: "user_a" } as never, gz);
    expect(JSON.parse(String(body.get("meta")))).toEqual({ library_id: "user_a" });
    expect(body.get("dmd")).toBeInstanceOf(Blob);
  });

  it("every refusal of the upload route becomes a Czech message", () => {
    expect(uploadOutcome(201, { id: "abc", status: "queued" })).toEqual({ ok: true, id: "abc" });
    expect(uploadOutcome(409, { error: "x", duplicate: { id: "d1", title: "Komentář" } })).toEqual({
      ok: false,
      message: "Tento dokument už v knihovně je („Komentář“).",
      duplicateId: "d1",
    });
    expect(uploadOutcome(409, { error: "Tento dokument už v knihovně je.", duplicate: { id: "d1", title: null } })).toMatchObject({ message: "Tento dokument už v knihovně je." });
    expect(uploadOutcome(403, { error: "Dokument má 900 normostran, v knihovně zbývá 12 z 3000." }).ok).toBe(false);
    expect(uploadOutcome(403, { error: "Dokument má 900 normostran, v knihovně zbývá 12 z 3000." })).toMatchObject({ message: expect.stringContaining("zbývá 12") });
    for (const status of [400, 401, 403, 413, 422, 429, 503, 500, 0]) {
      const out = uploadOutcome(status, null);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toMatch(/[ěščřžýáíéůú]/);
    }
    expect(uploadOutcome(201, {})).toMatchObject({ ok: false });
    expect(uploadOutcome(413, "garbage")).toMatchObject({ message: expect.stringContaining("menší rozsah") });
  });
});

// ---------------------------------------------------------------------------

const BASE: BibMeta = {
  doc_type: "kniha",
  title: "Občanský zákoník",
  subtitle: null,
  authors: ["Jan Petrov", "Milan Výtisk"],
  editors: [],
  year: 2019,
  edition: "2.",
  publisher: "C. H. Beck",
  place: "Praha",
  series: null,
  isbn: ["9788074007736"],
  issn: null,
  doi: null,
  container_title: null,
  volume: null,
  issue: null,
  pages_range: null,
  commented_act: null,
  commented_act_name: null,
  section_range: "§ 2894–3079",
  anchor_label: null,
  template_kind: null,
  court: null,
  case_number: null,
  ecli: null,
  decided_on: null,
  keywords: [],
  summary: null,
  language: "cs",
};

describe("metadata form", () => {
  it("every type starts with the title and ends with keywords and language (no summary)", () => {
    for (const t of DOC_TYPES) {
      const keys = fieldsFor(t).map((f) => f.key);
      expect(keys[0]).toBe("title");
      expect(keys.slice(-2)).toEqual(["keywords", "language"]);
      expect(keys).not.toContain("summary");
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(fieldsFor("komentar").find((f) => f.key === "commented_act")?.required).toBe(true);
    expect(fieldsFor("rozhodnuti").map((f) => f.key)).toEqual(expect.arrayContaining(["court", "case_number", "decided_on", "ecli"]));
    expect(fieldsFor("clanek").find((f) => f.key === "container_title")?.label).toBe("Časopis");
  });

  it("the form shows the essential fields up front, the rest under Další údaje", () => {
    for (const t of DOC_TYPES) {
      const { essential, extra } = splitFields(t);
      expect(essential[0].key).toBe("title");
      expect([...essential, ...extra].map((f) => f.key).sort()).toEqual(fieldsFor(t).map((f) => f.key).sort());
      expect(extra.some((f) => f.required)).toBe(false);
    }
    expect(splitFields("komentar").essential.map((f) => f.key)).toContain("commented_act");
    expect(splitFields("rozhodnuti").essential.map((f) => f.key)).toEqual(["title", "case_number", "decided_on"]);
    expect(splitFields("clanek").essential.map((f) => f.key)).toEqual(["title", "authors", "year"]);
    expect(splitFields("kniha").extra.map((f) => f.key)).toContain("isbn");
  });

  it("stored metadata → form → payload round-trips through the server schema", () => {
    const values = formFromMeta(BASE);
    expect(values.authors).toBe("Jan Petrov\nMilan Výtisk");
    expect(values.year).toBe("2019");
    const payload = payloadFromForm(values);
    const parsed = bibMetaSchema.parse(payload);
    expect(parsed).toMatchObject({ doc_type: "kniha", title: "Občanský zákoník", authors: ["Jan Petrov", "Milan Výtisk"], year: 2019, isbn: ["9788074007736"], publisher: "C. H. Beck" });
    // Derived on the server: sent empty, which keeps the stored value.
    expect(payload.section_range).toBeNull();
  });

  it("switching the type drops the other type's fields", () => {
    const values = { ...formFromMeta(BASE), doc_type: "clanek", container_title: "Právní rozhledy", volume: "27", issue: "5", pages_range: "417-425" };
    const payload = payloadFromForm(values);
    expect(payload.isbn).toEqual([]);
    expect(payload.publisher).toBeNull();
    expect(payload.edition).toBeNull();
    const parsed = bibMetaBaseSchema.parse(payload);
    expect(parsed).toMatchObject({ doc_type: "clanek", container_title: "Právní rozhledy", pages_range: "417–425", isbn: [] });
  });

  it("commentary and decision fields in the forms people type", () => {
    const komentar = formFromMeta({ ...BASE, doc_type: "komentar", commented_act: "zak:89/2012" });
    expect(komentar.commented_act).toBe("89/2012");
    expect(bibMetaSchema.parse(payloadFromForm(komentar)).commented_act).toBe("zak:89/2012");
    const decision = formFromMeta({ ...BASE, doc_type: "rozhodnuti", decided_on: "2019-04-24", case_number: "25 Cdo 1234/2019" });
    expect(decision.decided_on).toBe("24. 4. 2019");
    expect(bibMetaSchema.parse(payloadFromForm(decision)).decided_on).toBe("2019-04-24");
    expect(czechDate("nonsense")).toBe("nonsense");
    expect(actInput("eu:32016R0679")).toBe("32016R0679");
    // An unknown type in the form falls back to "jine" instead of reaching the server.
    expect(payloadFromForm({ ...komentar, doc_type: "<script>" }).doc_type).toBe("jine");
  });

  it("proposal badges and the low-confidence highlight", () => {
    const proposed = {
      title: { value: "X", source: "ai" as const, confidence: 0.4 },
      isbn: { value: ["1"], source: "heuristic" as const, confidence: 0.95 },
      doc_type: { value: "kniha" as const, source: "user" as const, confidence: 0.3 },
      year: { value: 2019, source: "bogus" as never, confidence: 0.9 },
    };
    expect(proposalBadge(proposed, "title")).toEqual({ label: "návrh AI", low: true });
    expect(proposalBadge(proposed, "isbn")).toEqual({ label: "z textu", low: false });
    expect(proposalBadge(proposed, "doc_type")).toEqual({ label: "od vás", low: false });
    expect(proposalBadge(proposed, "year")).toBeNull();
    expect(proposalBadge(null, "title")).toBeNull();
    expect(proposalBadge({ publisher: { value: "Y", source: "pdf", confidence: 0.6 } }, "publisher")?.label).toBe("z PDF");
    expect(proposalBadge({ title: { value: "a", source: "filename", confidence: 0.3 } }, "title")).toEqual({ label: "z názvu souboru", low: true });
  });
});

describe("team mapping", () => {
  it("names, e-mail addresses, members and invitations", () => {
    expect(displayName("Jana", "Nováková")).toBe("Jana Nováková");
    expect(displayName(null, null, "jana@novak.cz")).toBe("jana@novak.cz");
    expect(displayName(" ", "", "")).toBe("");
    expect(displayName("A‮B", "⟦x⟧")).not.toMatch(/[‮⟦⟧]/);
    expect(normalizeEmail("  Jana@Novak.CZ ")).toBe("jana@novak.cz");
    for (const bad of ["", "jana", "jana@", "@novak.cz", "a b@c.cz", "a@b", `${"x".repeat(250)}@a.cz`, 42, null]) expect(normalizeEmail(bad)).toBeNull();
    const members = mapMembers([
      { role: "org:member", createdAt: 2, publicUserData: { userId: "user_b", identifier: "b@x.cz", firstName: "Bára", lastName: null } },
      { role: "org:admin", createdAt: 1, publicUserData: { userId: "user_z", identifier: "z@x.cz", firstName: "Zdeněk", lastName: "Z" } },
      { role: "org:member", createdAt: 3, publicUserData: null },
    ]);
    expect(members.map((m) => [m.userId, m.admin])).toEqual([
      ["user_z", true],
      ["user_b", false],
    ]);
    const invitations = mapInvitations(
      [
        { id: "i1", emailAddress: "a@x.cz", organizationId: "org_t", status: "pending", createdAt: 1 },
        { id: "i2", emailAddress: "b@x.cz", organizationId: "org_t", status: "revoked", createdAt: 3 },
        { id: "i3", emailAddress: "c@x.cz", organizationId: "org_t", status: "revoked", createdAt: 2 },
        { id: "i4", emailAddress: "d@x.cz", organizationId: "org_t", status: "revoked", createdAt: 4 },
        { id: "i5", emailAddress: "e@x.cz", organizationId: "org_t", status: "accepted", createdAt: 5 },
      ],
      { declined: new Set(["i2", "i4"]), dismissed: new Set(["i4"]) },
    );
    expect(invitations.map((i) => [i.id, i.state])).toEqual([
      ["i2", "declined"],
      ["i1", "pending"],
    ]);
  });
});

describe("Czech cases and downloads (review web:Z4, export)", () => {
  it("counts pages in the accusative after zabere / má", () => {
    expect([1, 2, 4, 5, 22, 0].map(countPagesAcc)).toEqual(["1 stranu", "2 strany", "4 strany", "5 stran", "22 stran", "0 stran"]);
    expect([1, 3, 5].map(countPages)).toEqual(["1 strana", "3 strany", "5 stran"]);
  });

  it("the UI source has no fixed plural after a variable count", async () => {
    const { readFileSync } = await import("node:fs");
    const detail = readFileSync("app/_zdroje/detail.tsx", "utf8");
    // "3 účtovaných stran", "1 sporných stran": the plural must follow the number.
    expect(detail).not.toMatch(/\} (účtovaných|sporných) stran`/);
    expect(detail).toContain('plural(doc.billablePages, "účtovaná strana", "účtované strany", "účtovaných stran")');
    expect(detail).toContain('"sporná strana", "sporné strany", "sporných stran"');
    const upload = readFileSync("app/_zdroje/upload.tsx", "utf8");
    expect(upload).not.toMatch(/linkedPercent\}%/);
    expect(upload).toContain("Dokument má ${countPagesAcc(cost.pages)}");
  });

  it("names the download after Content-Disposition (UTF-8 first), never with a path", () => {
    const header = `attachment; filename="Komentar k OZ.md"; filename*=UTF-8''Koment%C3%A1%C5%99%20k%20OZ.md`;
    expect(downloadFileName(header, "dokument.md")).toBe("Komentář k OZ.md");
    expect(downloadFileName('attachment; filename="a.md"', "x.md")).toBe("a.md");
    expect(downloadFileName("attachment; filename=plain.md", "x.md")).toBe("plain.md");
    expect(downloadFileName("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd", "x.md")).toBe("_.._etc_passwd");
    expect(downloadFileName("attachment; filename*=UTF-8''%E0%A4%A", "x.md")).toBe("x.md");
    expect(downloadFileName(null, "dokument.md")).toBe("dokument.md");
  });
});

describe("upload guards (review web:Z2)", () => {
  it("names what an old browser lacks for converting and uploading", () => {
    class ModuleWorker {
      constructor(_url: string, opts?: { type?: string }) {
        void opts?.type;
      }
      terminate() {}
    }
    class ClassicWorker {
      constructor(_url: string) {}
      terminate() {}
    }
    const modern = { CompressionStream: class {}, crypto: { subtle: {} }, Worker: ModuleWorker } as unknown as typeof globalThis;
    expect(missingBrowserFeatures(modern)).toEqual([]);
    const oldSafari = { crypto: { subtle: {} }, Worker: ClassicWorker } as unknown as typeof globalThis;
    expect(missingBrowserFeatures(oldSafari)).toEqual(["CompressionStream", "module Worker"]);
    const insecure = { CompressionStream: class {}, crypto: {}, Worker: ModuleWorker } as unknown as typeof globalThis;
    expect(missingBrowserFeatures(insecure)).toEqual(["crypto.subtle"]);
  });
});

describe("no document-derived HTML", () => {
  it("the Vlastní zdroje UI never uses dangerouslySetInnerHTML", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dirs = ["app/_zdroje", "app/vlastni-zdroje", "app/vlastni-zdroje/provoz"];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((f) => /\.(tsx?|mts)$/.test(f))) {
        expect(readFileSync(`${dir}/${name}`, "utf8"), `${dir}/${name}`).not.toContain("dangerouslySetInnerHTML");
      }
    }
  });
});
