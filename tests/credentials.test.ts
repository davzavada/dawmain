import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsConfigured, isLibraryId, openSecret, sealSecret } from "@/src/mcp/credentials";

/**
 * The sealing of readers' library passwords — the one place a secret is
 * written anywhere. What must hold: nothing is stored without the
 * deployment's key, a sealed value opens only under the same key, and two
 * sealings of the same password never look alike.
 */
describe("reader credentials sealing", () => {
  const original = process.env.CREDENTIALS_SECRET;
  beforeEach(() => {
    process.env.CREDENTIALS_SECRET = "a-test-secret-of-sufficient-length";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CREDENTIALS_SECRET;
    else process.env.CREDENTIALS_SECRET = original;
  });

  it("round-trips a password and never repeats a ciphertext", () => {
    const one = sealSecret("tajné heslo ✓");
    const two = sealSecret("tajné heslo ✓");
    expect(one).not.toBe(two);
    expect(openSecret(one)).toBe("tajné heslo ✓");
    expect(openSecret(two)).toBe("tajné heslo ✓");
    expect(one).not.toContain("tajné");
  });

  it("refuses to open under another key or when tampered with", () => {
    const sealed = sealSecret("heslo");
    process.env.CREDENTIALS_SECRET = "a-different-secret-of-sufficient-length";
    expect(() => openSecret(sealed)).toThrow();
    process.env.CREDENTIALS_SECRET = "a-test-secret-of-sufficient-length";
    const raw = Buffer.from(sealed, "base64");
    raw[raw.length - 1] ^= 0x01;
    expect(() => openSecret(raw.toString("base64"))).toThrow();
    expect(() => openSecret("c2hvcnQ=")).toThrow(/too short/);
  });

  it("does nothing without a configured secret", () => {
    delete process.env.CREDENTIALS_SECRET;
    expect(credentialsConfigured()).toBe(false);
    expect(() => sealSecret("x")).toThrow(/CREDENTIALS_SECRET/);
    process.env.CREDENTIALS_SECRET = "short";
    expect(credentialsConfigured()).toBe(false);
  });

  it("knows the two libraries", () => {
    expect(isLibraryId("cuni")).toBe(true);
    expect(isLibraryId("peacepalace")).toBe(true);
    expect(isLibraryId("worldcat")).toBe(false);
  });
});
