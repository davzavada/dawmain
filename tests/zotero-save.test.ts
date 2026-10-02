import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/zotero/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/zotero/client")>();
  // Every call is a mock; only createItem is expected to run.
  const mocked = Object.fromEntries(Object.entries(actual).map(([name, value]) => [name, typeof value === "function" ? vi.fn() : value]));
  return { ...mocked, newWriteToken: vi.fn(() => "0123456789abcdef0123456789abcdef") };
});
vi.mock("@/src/zotero/store", () => ({ loadConnection: vi.fn(), markRevoked: vi.fn() }));
vi.mock("@/src/zotero/pdf-text", () => ({ pdfText: vi.fn() }));
vi.mock("@/src/zotero/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/zotero/http")>()),
  zoteroBreakerOpen: vi.fn(() => false),
}));

import { __setAccessLoaderForTests } from "@/src/files/access";
import type { Access, LibraryAccess } from "@/src/files/access-types";
import { __resetGuardsForTests } from "@/src/files/guards";
import { buildInstructions } from "@/src/mcp/server";
import { __resetZoteroToolsForTests, registerZotero, saveItemData } from "@/src/mcp/tools/zotero";
import * as client from "@/src/zotero/client";
import { LIMITS } from "@/src/zotero/config";
import { ZoteroKeyInvalidError } from "@/src/zotero/http";
import { loadConnection, markRevoked } from "@/src/zotero/store";
import type { ConnectionState } from "@/src/zotero/types";
import { SourceError } from "@/src/sources/shared/errors";

/**
 * zotero_save — the one write of the Zotero tools: ONE new item in the
 * personal library, only for a connection in "write" mode. The real handler
 * over a mocked client (createItem is pinned by tests/zotero-client.test.ts)
 * and store; Clerk is replaced by an access loader.
 */

const USER = "user_zot1";
const ZUSER = 475425;
const CONNECT = "https://dawmain.davidzavada.cz/?zotero=1";
const API_KEY = "AbCdEfGhIjKlMnOpQrStUvWx";

const ENV: Record<string, string> = {
  ZOTERO_OAUTH_CLIENT_KEY: "consumer-key",
  ZOTERO_OAUTH_CLIENT_SECRET: "consumer-secret",
  CREDENTIALS_SECRET: "a-test-secret-that-is-long-enough-1234",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_zotero",
  CLERK_SECRET_KEY: "sk_test_zotero",
};

const LIB: LibraryAccess = { id: USER, kind: "user", name: "Osobní", slug: null, role: "owner", pro: true, canUpload: true, canManageAll: true, quotaPages: 3000 };
const PRO: Access = { userId: USER, banned: false, libraries: [LIB], all: [LIB], zotero: true };
const NON_PRO: Access = { userId: USER, banned: false, libraries: [], all: [{ ...LIB, pro: false, canUpload: false }], zotero: false };

function connection(mode: "read" | "write" = "write"): ConnectionState {
  return {
    state: "ok",
    conn: { creds: { userID: ZUSER, key: API_KEY }, username: "zuser", notes: true, groups: "all", connectedAt: "2026-09-01T10:00:00Z", fp: "fp-current", mode },
  };
}

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>;
const tools: Record<string, { handler: Handler; config: Record<string, unknown> }> = {};
registerZotero({
  registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
    tools[name] = { handler, config };
  },
} as never);

const USER_CTX = { http: { authInfo: { token: "t", clientId: "c", scopes: [], extra: { userId: USER } } } };
const SHARED_CTX = { http: { authInfo: { token: "t", clientId: "shared-token", scopes: [], extra: { method: "token" } } } };

const schema = () => tools.zotero_save.config.inputSchema as { parse: (v: unknown) => Record<string, unknown>; safeParse: (v: unknown) => { success: boolean } };

async function save(args: Record<string, unknown>, ctx: unknown = USER_CTX): Promise<{ text: string; isError: boolean }> {
  const result = await tools.zotero_save.handler(schema().parse(args), ctx);
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

const CASE = {
  item_type: "case",
  title: "Rozsudek Nejvyššího soudu sp. zn. 25 Cdo 1234/2019",
  court: "Nejvyšší soud",
  docketNumber: "25 Cdo 1234/2019",
  date: "2019-05-14",
  url: "https://nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/1",
  abstractNote: "Odpovědnost za škodu.",
  extra: "ECLI: ECLI:CZ:NS:2019:25.CDO.1234.2019.1",
  creators: [{ name: "Nejvyšší soud" }],
};

const loader = vi.fn<(userId: string) => Promise<Access>>();
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  savedEnv.VERCEL_PROJECT_PRODUCTION_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  vi.clearAllMocks();
  __resetGuardsForTests();
  __resetZoteroToolsForTests();
  loader.mockReset();
  loader.mockImplementation(async () => PRO);
  __setAccessLoaderForTests(loader);
  vi.mocked(loadConnection).mockResolvedValue(connection());
  vi.mocked(markRevoked).mockResolvedValue(true);
  vi.mocked(client.createItem).mockResolvedValue({ key: "NEWK2345", version: 7, webLink: "https://www.zotero.org/zuser/items/NEWK2345" });
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __setAccessLoaderForTests(null);
});

/** Every client function but createItem and the token: none of them may run for a save. */
function otherClientCalls(): string[] {
  return Object.entries(client)
    .filter(([name, fn]) => name !== "createItem" && name !== "newWriteToken" && vi.isMockFunction(fn) && fn.mock.calls.length > 0)
    .map(([name]) => name);
}

describe("zotero_save — registration and texts", () => {
  it("is described as create-only, personal library, on the user's request, and annotated as a non-destructive write", () => {
    const description = String(tools.zotero_save.config.description);
    expect(description).toContain("CREATE ONLY");
    expect(description).toContain("PERSONAL");
    expect(description).toContain("„Číst a ukládat“");
    expect(description).toContain("zotero_search first");
    expect(tools.zotero_save.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  });

  it("takes the asked-for item types and refuses others, a non-http url and an unnamed creator type", () => {
    for (const type of ["journalArticle", "book", "bookSection", "case", "statute", "webpage", "document"]) {
      expect(schema().safeParse({ item_type: type, title: "X" }).success, type).toBe(true);
    }
    expect(schema().safeParse({ item_type: "note", title: "X" }).success).toBe(false);
    expect(schema().safeParse({ item_type: "attachment", title: "X" }).success).toBe(false);
    expect(schema().safeParse({ item_type: "book", title: "X", url: "javascript:alert(1)" }).success).toBe(false);
    expect(schema().safeParse({ item_type: "book", title: "   " }).success).toBe(false);
    // No way to name an existing item, a group or a collection.
    const props = Object.keys((tools.zotero_save.config.inputSchema as { shape: Record<string, unknown> }).shape);
    for (const forbidden of ["key", "library", "collection", "collections", "version", "parentItem"]) expect(props).not.toContain(forbidden);
  });

  it("the server instructions and the read tools no longer call Zotero read-only", () => {
    const instructions = buildInstructions(true);
    expect(instructions).not.toMatch(/Zotero library,? read-only|Zotero library \(read-only\)/);
    expect(instructions).toMatch(/zotero_save = ONE new item in the personal library \(create only/);
    expect(String(tools.zotero_search.config.description)).not.toContain("read-only");
  });
});

describe("zotero_save — saving", () => {
  it("creates ONE item in the personal library with the type's own fields, and answers its key and zotero.org link", async () => {
    const r = await save(CASE);
    expect(r.isError).toBe(false);
    expect(vi.mocked(client.createItem)).toHaveBeenCalledTimes(1);
    const [creds, data, token] = vi.mocked(client.createItem).mock.calls[0];
    expect(creds).toEqual({ userID: ZUSER, key: API_KEY });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(data).toEqual({
      itemType: "case",
      caseName: CASE.title,
      court: "Nejvyšší soud",
      docketNumber: "25 Cdo 1234/2019",
      dateDecided: "2019-05-14",
      url: CASE.url,
      accessDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      abstractNote: "Odpovědnost za škodu.",
      extra: CASE.extra,
      creators: [{ creatorType: "author", name: "Nejvyšší soud" }],
    });
    // No collection, no tag of its own, nothing that would update an existing item.
    for (const field of ["collections", "tags", "key", "version", "parentItem"]) expect(data).not.toHaveProperty(field);
    expect(r.text).toContain("NEWK2345");
    expect(r.text).toContain("https://www.zotero.org/zuser/items/NEWK2345");
    expect(r.text).toContain('zotero_get_item {key: "NEWK2345", library: "personal"}');
    expect(otherClientCalls()).toEqual([]);
  });

  it("maps title and date to each type's own fields, people to last/first name, and adds only the tags given", () => {
    const now = new Date("2026-10-02T12:34:56Z");
    expect(saveItemData({ item_type: "statute", title: "Občanský zákoník", date: "2012-02-03", codeNumber: "89/2012 Sb." }, now)).toEqual({
      itemType: "statute",
      nameOfAct: "Občanský zákoník",
      dateEnacted: "2012-02-03",
      codeNumber: "89/2012 Sb.",
    });
    expect(
      saveItemData(
        {
          item_type: "journalArticle",
          title: "Náhrada škody",
          publicationTitle: "Právní rozhledy",
          volume: "27",
          issue: "5",
          pages: "150-160",
          creators: [{ type: "author", last_name: "Novák", first_name: "Jan" }],
          tags: ["škoda", " škoda ", "NOZ"],
          url: "https://example.cz/clanek",
        },
        now,
      ),
    ).toEqual({
      itemType: "journalArticle",
      title: "Náhrada škody",
      publicationTitle: "Právní rozhledy",
      volume: "27",
      issue: "5",
      pages: "150-160",
      url: "https://example.cz/clanek",
      accessDate: "2026-10-02 12:34:56",
      creators: [{ creatorType: "author", lastName: "Novák", firstName: "Jan" }],
      tags: [{ tag: "škoda" }, { tag: "NOZ" }],
    });
    expect(saveItemData({ item_type: "book", title: "Komentář", publisher: "C. H. Beck", place: "Praha", ISBN: "978-80-7400-000-0" })).toMatchObject({
      itemType: "book",
      publisher: "C. H. Beck",
      place: "Praha",
      ISBN: "978-80-7400-000-0",
    });
  });

  it("refuses a field or creator type the item type does not have, before any request", async () => {
    const wrongField = await save({ item_type: "book", title: "X", court: "Nejvyšší soud" });
    expect(wrongField.isError).toBe(true);
    expect(wrongField.text).toContain("book has no field court");
    const wrongCreator = await save({ item_type: "case", title: "X", creators: [{ type: "editor", name: "Y" }] });
    expect(wrongCreator.isError).toBe(true);
    expect(wrongCreator.text).toContain('no creator type "editor"');
    const nameless = await save({ item_type: "book", title: "X", creators: [{ first_name: "Jan" }] });
    expect(nameless.isError).toBe(true);
    expect(vi.mocked(client.createItem)).not.toHaveBeenCalled();
  });

  it("passes Zotero's refusal on and marks a rejected key revoked", async () => {
    vi.mocked(client.createItem).mockRejectedValueOnce(new SourceError("Zotero", "NOT_ENTITLED", "Zotero refused the write (HTTP 403).", "Nothing was saved."));
    const denied = await save(CASE);
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("Nothing was saved");

    vi.mocked(client.createItem).mockRejectedValueOnce(new ZoteroKeyInvalidError());
    const rejected = await save(CASE);
    expect(rejected.isError).toBe(true);
    expect(vi.mocked(markRevoked)).toHaveBeenCalledWith(USER, "fp-current");
  });

  it(`at most ${LIMITS.savesPerHour} saves per hour per user, with a Czech sentence`, async () => {
    for (let i = 0; i < LIMITS.savesPerHour; i++) expect((await save({ item_type: "document", title: `Doc ${i}` })).isError).toBe(false);
    const r = await save({ item_type: "document", title: "One too many" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("pokusů bylo příliš mnoho");
    expect(vi.mocked(client.createItem)).toHaveBeenCalledTimes(LIMITS.savesPerHour);
  });
});

describe("zotero_save — refusals (Czech for the user, nothing sent to Zotero)", () => {
  async function expectRefused(ctx: unknown, czech: string): Promise<string> {
    const r = await save(CASE, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Uložení do Zotera se nepovedlo \(řekněte to uživateli\): /);
    expect(r.text).toContain(czech);
    expect(vi.mocked(client.createItem)).not.toHaveBeenCalled();
    return r.text;
  }

  it("connected read-only: refused, names the reconnect with „Číst a ukládat“", async () => {
    vi.mocked(loadConnection).mockResolvedValue(connection("read"));
    const text = await expectRefused(USER_CTX, "Zotero je připojené jen ke čtení");
    expect(text).toContain("„Číst a ukládat“");
    expect(text).toContain(CONNECT);
    expect(text).toContain("Do not call zotero_save again");
  });

  it("not connected, revoked or unreadable", async () => {
    vi.mocked(loadConnection).mockResolvedValue({ state: "none" });
    await expectRefused(USER_CTX, "Zotero není připojené");
    vi.mocked(loadConnection).mockResolvedValue({ state: "revoked", username: "zuser", revokedAt: "2026-09-20T08:00:00Z" });
    await expectRefused(USER_CTX, "Klíč k Zoteru přestal platit");
    vi.mocked(loadConnection).mockResolvedValue({ state: "unreadable", username: "zuser" });
    await expectRefused(USER_CTX, "Připojení Zotera je potřeba obnovit");
  });

  it("without Pro, with the shared access code, or on a deployment without Zotero", async () => {
    loader.mockImplementation(async () => NON_PRO);
    await expectRefused(USER_CTX, "jen v režimu Pro");
    loader.mockImplementation(async () => PRO);
    await expectRefused(SHARED_CTX, "osobním přihlášení");
    delete process.env.ZOTERO_OAUTH_CLIENT_SECRET;
    await expectRefused(USER_CTX, "není na tomto webu zapnuté");
  });
});
