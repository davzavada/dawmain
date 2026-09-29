import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSecret, sealSecret, secretsConfigured } from "@/src/secrets/seal";

/**
 * Sealing per-user secrets (a Zotero API key, the OAuth state cookie) — the
 * one place a secret is written anywhere. What must hold: nothing is sealed
 * without the deployment's key, a sealed value opens only under the same
 * key, purpose and context (aad), and two sealings of the same secret never
 * look alike. Ported from the reader-credentials test removed in 85d0bcc.
 */

const SECRET = "a-test-secret-of-sufficient-length";
const OTHER_SECRET = "a-different-secret-of-sufficient-length";
const AAD = "zotero:user_2abcDEF";

/** Flip one bit of the decoded blob and re-encode it canonically. */
function tamper(sealed: string, index: number): string {
  const raw = Buffer.from(sealed.slice(3), "base64url");
  raw[index < 0 ? raw.length + index : index] ^= 0x01;
  return "v1." + raw.toString("base64url");
}

describe("secret sealing", () => {
  const original = process.env.CREDENTIALS_SECRET;
  beforeEach(() => {
    process.env.CREDENTIALS_SECRET = SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CREDENTIALS_SECRET;
    else process.env.CREDENTIALS_SECRET = original;
  });

  it("round-trips unicode and never repeats a ciphertext", () => {
    const plain = "tajný klíč ✓ — 𝒵otero 🔑";
    const one = sealSecret(plain, "zotero-api-key-v1", AAD);
    const two = sealSecret(plain, "zotero-api-key-v1", AAD);
    expect(one).not.toBe(two);
    expect(one).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(openSecret(one, "zotero-api-key-v1", AAD)).toBe(plain);
    expect(openSecret(two, "zotero-api-key-v1", AAD)).toBe(plain);
  });

  it("never contains the plaintext, in any common encoding", () => {
    const plain = "P9NiFoyLeZu2bZNvvuQPDWsd";
    const sealed = sealSecret(plain, "zotero-api-key-v1", AAD);
    const raw = Buffer.from(sealed.slice(3), "base64url");
    expect(sealed).not.toContain(plain);
    expect(raw.includes(Buffer.from(plain, "utf8"))).toBe(false);
    expect(sealed).not.toContain(Buffer.from(plain).toString("base64url").slice(0, 16));
    expect(sealed).not.toContain(Buffer.from(plain).toString("base64").slice(0, 16));
  });

  it("round-trips an empty string (seal and open are inverse for every input)", () => {
    const sealed = sealSecret("", "zotero-api-key-v1", AAD);
    expect(openSecret(sealed, "zotero-api-key-v1", AAD)).toBe("");
  });

  it("refuses to open under another CREDENTIALS_SECRET", () => {
    const sealed = sealSecret("klíč", "zotero-api-key-v1", AAD);
    process.env.CREDENTIALS_SECRET = OTHER_SECRET;
    expect(() => openSecret(sealed, "zotero-api-key-v1", AAD)).toThrow();
    process.env.CREDENTIALS_SECRET = SECRET;
    expect(openSecret(sealed, "zotero-api-key-v1", AAD)).toBe("klíč");
  });

  it("refuses to open for another purpose", () => {
    const sealed = sealSecret("klíč", "zotero-api-key-v1", AAD);
    expect(() => openSecret(sealed, "zotero-oauth-state-v1", AAD)).toThrow();
    const state = sealSecret("stav", "zotero-oauth-state-v1", "state:user_1");
    expect(() => openSecret(state, "zotero-api-key-v1", "state:user_1")).toThrow();
  });

  it("refuses to open with another aad (a blob copied onto another account)", () => {
    const sealed = sealSecret("klíč", "zotero-api-key-v1", "zotero:user_A");
    expect(() => openSecret(sealed, "zotero-api-key-v1", "zotero:user_B")).toThrow();
    expect(() => openSecret(sealed, "zotero-api-key-v1", "")).toThrow();
    expect(openSecret(sealed, "zotero-api-key-v1", "zotero:user_A")).toBe("klíč");
  });

  it("refuses any tampered byte — IV, tag or ciphertext", () => {
    const sealed = sealSecret("klíč k Zoteru", "zotero-api-key-v1", AAD);
    for (const index of [0, 11, 12, 27, 28, -1]) {
      expect(() => openSecret(tamper(sealed, index), "zotero-api-key-v1", AAD)).toThrow();
    }
  });

  it("refuses a non-canonical encoding of the same bytes", () => {
    const sealed = sealSecret("klíč", "zotero-api-key-v1", AAD);
    const body = sealed.slice(3);
    // Characters outside the alphabet and standard-base64 padding would be
    // skipped by the decoder; they must not be accepted as the same blob.
    expect(() => openSecret(`v1.${body.slice(0, 10)}\n${body.slice(10)}`, "zotero-api-key-v1", AAD)).toThrow(/unknown format/);
    expect(() => openSecret(`v1.${body}=`, "zotero-api-key-v1", AAD)).toThrow(/unknown format/);
  });

  it("refuses an unknown prefix or a blob that is too short", () => {
    const sealed = sealSecret("klíč", "zotero-api-key-v1", AAD);
    expect(() => openSecret(sealed.slice(3), "zotero-api-key-v1", AAD)).toThrow(/unknown format/);
    expect(() => openSecret("v2." + sealed.slice(3), "zotero-api-key-v1", AAD)).toThrow(/unknown format/);
    expect(() => openSecret("", "zotero-api-key-v1", AAD)).toThrow(/unknown format/);
    expect(() => openSecret("v1.c2hvcnQ", "zotero-api-key-v1", AAD)).toThrow(/too short/);
    expect(() => openSecret("v1.", "zotero-api-key-v1", AAD)).toThrow(/too short/);
  });

  it("does nothing without a configured secret", () => {
    delete process.env.CREDENTIALS_SECRET;
    expect(secretsConfigured()).toBe(false);
    expect(() => sealSecret("x", "zotero-api-key-v1", AAD)).toThrow(/CREDENTIALS_SECRET/);
    process.env.CREDENTIALS_SECRET = "short";
    expect(secretsConfigured()).toBe(false);
    expect(() => sealSecret("x", "zotero-api-key-v1", AAD)).toThrow(/CREDENTIALS_SECRET/);
    // 31 characters after trimming is still too short.
    process.env.CREDENTIALS_SECRET = `  ${"x".repeat(31)}  `;
    expect(secretsConfigured()).toBe(false);
    process.env.CREDENTIALS_SECRET = "x".repeat(32);
    expect(secretsConfigured()).toBe(true);
  });

  it("an error never carries the plaintext or the secret", () => {
    const sealed = sealSecret("P9NiFoyLeZu2bZNvvuQPDWsd", "zotero-api-key-v1", AAD);
    process.env.CREDENTIALS_SECRET = OTHER_SECRET;
    let message = "";
    try {
      openSecret(sealed, "zotero-api-key-v1", AAD);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("P9NiFoyLeZu2bZNvvuQPDWsd");
    expect(message).not.toContain(OTHER_SECRET);
    expect(message).not.toContain(SECRET);
  });
});
