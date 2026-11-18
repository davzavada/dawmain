import { describe, expect, it } from "vitest";
import { cleanTeamChange, cleanTeamName, membersLabel, teamMetadataPatch, toAdminTeam, validTeamQuota } from "@/src/admin/teams-model";

/** The Týmy tab's pure model (src/admin/teams-model.ts): validation and the mapping from Clerk. */

describe("cleanTeamName", () => {
  it("accepts plain names, collapses whitespace, refuses the rest", () => {
    expect(cleanTeamName("  Spory   a  arbitráže ")).toBe("Spory a arbitráže");
    expect(cleanTeamName("Tým 2 (Praha)")).toBe("Tým 2 (Praha)");
    for (const bad of ["", "A", "x".repeat(61), "<b>Tým</b>", "Tým\u0000", 42, null, "-Tým"]) expect(cleanTeamName(bad)).toBeNull();
  });
});

describe("cleanTeamChange", () => {
  it("rebuilds valid changes from their checked fields only", () => {
    expect(cleanTeamChange({ kind: "create", name: " Spory ", extra: 1 })).toEqual({ kind: "create", name: "Spory" });
    expect(cleanTeamChange({ kind: "active", on: false, pro: true })).toEqual({ kind: "active", on: false });
    expect(cleanTeamChange({ kind: "quota", mb: null })).toEqual({ kind: "quota", mb: null });
    expect(cleanTeamChange({ kind: "quota", mb: 500 })).toEqual({ kind: "quota", mb: 500 });
    expect(cleanTeamChange({ kind: "addMember", userId: "user_a1", role: "org:admin" })).toEqual({ kind: "addMember", userId: "user_a1", role: "org:admin" });
    expect(cleanTeamChange({ kind: "setRole", userId: "user_a1", role: "org:member" })).toEqual({ kind: "setRole", userId: "user_a1", role: "org:member" });
    expect(cleanTeamChange({ kind: "removeMember", userId: "user_a1" })).toEqual({ kind: "removeMember", userId: "user_a1" });
    expect(cleanTeamChange({ kind: "delete", force: true })).toEqual({ kind: "delete" });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "delete",
      { kind: "nuke" },
      { kind: "rename", name: "" },
      { kind: "active", on: "yes" },
      { kind: "quota", mb: 0 },
      { kind: "quota", mb: 1.5 },
      { kind: "quota", mb: 100_001 },
      { kind: "quota", pages: 500 },
      { kind: "addMember", userId: "org_x", role: "org:member" },
      { kind: "addMember", userId: "user_a", role: "owner" },
      { kind: "setRole", userId: "user_a;--", role: "org:admin" },
      { kind: "removeMember" },
    ]) {
      expect(cleanTeamChange(bad)).toBeNull();
    }
    expect(validTeamQuota(1)).toBe(true);
    expect(validTeamQuota(NaN)).toBe(false);
  });
});

describe("toAdminTeam", () => {
  it("maps the organization, keeps valid members once, reads active and quota strictly", () => {
    const team = toAdminTeam(
      { id: "org_t", name: "Spory", slug: "spory", createdAt: 1, publicMetadata: { pro: true, filesQuota: { mb: 1234 } } },
      [
        { role: "org:admin", createdAt: 2, publicUserData: { userId: "user_a" } },
        { role: "org:member", publicUserData: { userId: "user_b" } },
        { role: "org:member", publicUserData: { userId: "user_b" } },
        { role: "org:weird", publicUserData: { userId: "user_c" } },
        { role: "org:member", publicUserData: null },
        { role: "org:member", publicUserData: { userId: "bad id" } },
      ],
      { documents: 3, pages: 40, bytes: 5_000, purgeAfter: null },
    );
    expect(team).toEqual({
      id: "org_t",
      name: "Spory",
      slug: "spory",
      createdAt: 1,
      active: true,
      quotaMb: 1234,
      logoUrl: null,
      members: [
        { userId: "user_a", role: "org:admin", joinedAt: 2 },
        { userId: "user_b", role: "org:member", joinedAt: null },
        { userId: "user_c", role: "org:member", joinedAt: null },
      ],
      library: { documents: 3, pages: 40, bytes: 5_000, purgeAfter: null },
    });
    for (const meta of [{ pro: "true" }, {}, null]) expect(toAdminTeam({ id: "org_t", publicMetadata: meta }, [], null).active).toBe(false);
    expect(toAdminTeam({ id: "org_t", name: " ", slug: "s" }, [], null).name).toBe("s");
    // The logo only when an admin uploaded one (Clerk generates an imageUrl anyway), and only over https.
    const logo = (org: Record<string, unknown>) => toAdminTeam({ id: "org_t", ...org }, [], null).logoUrl;
    expect(logo({ hasImage: true, imageUrl: "https://img.clerk.com/x.png" })).toBe("https://img.clerk.com/x.png");
    expect(logo({ hasImage: false, imageUrl: "https://img.clerk.com/generated.png" })).toBeNull();
    expect(logo({ hasImage: true, imageUrl: "http://img.clerk.com/x.png" })).toBeNull();
    expect(logo({ hasImage: true, imageUrl: "javascript:alert(1)" })).toBeNull();
    expect(logo({ hasImage: true })).toBeNull();
  });

  it("metadata patches and labels", () => {
    expect(teamMetadataPatch({ kind: "active", on: true })).toEqual({ pro: true });
    expect(teamMetadataPatch({ kind: "quota", mb: null })).toEqual({ filesQuota: null });
    expect(teamMetadataPatch({ kind: "quota", mb: 9 })).toEqual({ filesQuota: { mb: 9, pages: null } });
    expect([1, 2, 4, 5, 0].map(membersLabel)).toEqual(["1 člen", "2 členové", "4 členové", "5 členů", "0 členů"]);
  });
});
