import { describe, expect, it } from "vitest";
import { parseJusticeDecision } from "@/src/sources/justice";
import { pageOrExcerpt } from "@/src/sources/shared/text";

/**
 * Trimmed from live finaldoc 8d2e6b9a-c687-4805-9a26-bb46db6aec93 (fetched
 * 2026-09 through dawmain_probe_sources): the arrays hold one paragraph per
 * entry, while verdictText/justificationText run the paragraphs together with
 * no separator — and neither flat field carries the záhlaví or the poučení.
 */
const para = (...texts: string[]) => ({
  texts: texts.map((text) => ({ text, anonStyle: "NONE" })),
  styleLocalId: 9,
  tableCellInfo: null,
});

const live = {
  uuid: "8d2e6b9a-c687-4805-9a26-bb46db6aec93",
  header: [
    para("Krajský soud v Ostravě rozhodl pověřeným členem senátu JUDr. Martinem Putíkem, Ph.D., ve věci"),
    para("žalobkyně: ", "Jméno žalobkyně", "., IČO ", "IČO žalobkyně"),
    para("proti"),
    para("k odvolání žalobkyně proti rozsudku Okresního soudu v Novém Jičíně ze dne 8. 11. 2024, č. j. 12 C 2/2024-144,"),
  ],
  verdict: [
    para("I. Odvolací řízení se v rozsahu odvolání … do zaplacení zastavuje."),
    para("II. Žádný z účastníků nemá právo na náhradu nákladů této části odvolacího řízení."),
  ],
  verdictText:
    "I. Odvolací řízení se v rozsahu odvolání … do zaplacení zastavuje.II. Žádný z účastníků nemá právo na náhradu nákladů této části odvolacího řízení.",
  justification: [
    para("1. Rozsudkem v záhlaví označeným okresní soud zamítl žalobu … (odstavec II. výroku)."),
    para("2. Proti tomuto rozsudku podala žalobykně včas odvolání …"),
    para("3. Odvolací soud … odvolací řízení v daném rozsahu zastavil."),
  ],
  justificationText:
    "1. Rozsudkem v záhlaví označeným okresní soud zamítl žalobu … (odstavec II. výroku).2. Proti tomuto rozsudku podala žalobykně včas odvolání …3. Odvolací soud … odvolací řízení v daném rozsahu zastavil.",
  information: [para("Proti tomuto usnesení není dovolání přípustné.")],
  metadata: { type: "RESOLUTION", courtCode: "KSOS" },
};

describe("parseJusticeDecision — paragraph arrays first", () => {
  it("reads záhlaví, výrok and odůvodnění one paragraph per line, then the poučení", () => {
    const { text } = parseJusticeDecision(live, live.uuid);
    expect(text.startsWith("Krajský soud v Ostravě rozhodl")).toBe(true);
    expect(text).toContain("žalobkyně: Jméno žalobkyně., IČO IČO žalobkyně");
    expect(text).toContain("zastavuje.\nII. Žádný");
    expect(text).toContain("výroku).\n2. Proti tomuto rozsudku");
    expect(text).not.toContain("výroku).2. Proti");
    expect(text.endsWith("Proti tomuto usnesení není dovolání přípustné.")).toBe(true);
  });

  it("lets find's excerpt open at the bod holding the match — the number a citation needs", () => {
    const { text } = parseJusticeDecision(live, live.uuid);
    expect(pageOrExcerpt(text, 1, "Proti tomuto rozsudku").text.startsWith("2. Proti tomuto rozsudku")).toBe(true);
  });

  it("falls back per section, so one drifted null array cannot drop the odůvodnění", () => {
    const { text } = parseJusticeDecision({ ...live, justification: null, information: null }, live.uuid);
    expect(text).toContain("Krajský soud v Ostravě");
    expect(text).toContain("zastavuje.\nII. Žádný");
    expect(text).toContain("1. Rozsudkem v záhlaví označeným");
    expect(text).toContain("v daném rozsahu zastavil.");
  });

  it("takes a paragraph that drifted to a bare string as it is, and skips junk pieces", () => {
    const { text } = parseJusticeDecision(
      { verdict: ["Výrok."], justification: [{ texts: [{ text: "Odůvodnění." }, null, { text: 5 }] }] },
      "x",
    );
    expect(text).toBe("Výrok.\n\nOdůvodnění.");
  });
});
