import { beforeEach } from "vitest";

// e-Sbírka is reached through the registered API only (src/sources/esbirka.ts),
// so every test starts with a key configured; a test about the missing key
// deletes it itself.
beforeEach(() => {
  process.env.ESBIRKA_API_KEY ??= "test-key";
});
