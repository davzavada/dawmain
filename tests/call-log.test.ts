import { describe, expect, it } from "vitest";
import { logNote } from "@/src/mcp/tools";

const text = (...parts: string[]) => parts.map((part) => ({ type: "text", text: part }));

describe("the service log's note on a call", () => {
  it("says nothing of a call that went well", () => {
    expect(logNote({ content: text("1. 25 Cdo 2578/98 …") })).toBe("");
  });

  it("gives the first line of an error", () => {
    expect(logNote({ isError: true, content: text("caselaw_search: no answer within the 54 s one call may take here.\nNarrow the call.") })).toBe(
      " error: caselaw_search: no answer within the 54 s one call may take here.",
    );
    expect(logNote({ isError: true, content: [] })).toBe(" error");
  });

  it("says that the live court answered and why, and the error behind it", () => {
    const note = "[Mirror not used: the mirror did not answer (variant \"smluvní pokuta\": The case-law mirror is paused after a failure (timeout)) — answered live from the court.]";
    expect(logNote({ content: text(note, "✓ NS: 12 matches") })).toBe(
      " live (the mirror did not answer (variant …: The case-law mirror is paused after a failure (timeout)))",
    );
    expect(logNote({ isError: true, content: text(note, "No court answered:\n✗ NS: …") })).toContain("; error: No court answered:");
  });

  it("leaves out what the caller wrote: a research's content is not kept", () => {
    const out = logNote({ isError: true, content: text('The query could not be read — variant "nájem AND (výpověď": an unclosed bracket; „23 Cdo 1/2020“ «újma».') });
    expect(out).not.toContain("nájem");
    expect(out).not.toContain("23 Cdo");
    expect(out).not.toContain("újma");
    expect(out).toContain("an unclosed bracket");
  });

  it("keeps a reason short", () => {
    expect(logNote({ isError: true, content: text("x".repeat(1000)) }).length).toBeLessThan(180);
  });
});
