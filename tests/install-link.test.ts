import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { claudeInstallLink } from "@/app/_install-link";

/**
 * The "Přidat Dawmain do Claude" button (app/_guide.tsx): Anthropic's install
 * link for a custom connector, with the MCP address percent-encoded.
 */
describe("claudeInstallLink", () => {
  it("opens the add-custom-connector dialog with the name and the encoded address", () => {
    expect(claudeInstallLink("https://dawmain.davidzavada.cz/api/mcp")).toBe(
      "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Dawmain&connectorUrl=https%3A%2F%2Fdawmain.davidzavada.cz%2Fapi%2Fmcp",
    );
  });

  it("round-trips an address with a port and a query (a preview or localhost)", () => {
    const endpoint = "http://localhost:3000/api/mcp?x=1&y=2";
    const link = new URL(claudeInstallLink(endpoint, "Dawmain (dev)"));
    expect(link.searchParams.get("connectorUrl")).toBe(endpoint);
    expect(link.searchParams.get("connectorName")).toBe("Dawmain (dev)");
    expect(link.searchParams.get("modal")).toBe("add-custom-connector");
  });

  it("the README carries the same link as the website builds", () => {
    const readme = readFileSync(path.join(path.dirname(__dirname), "README.md"), "utf8");
    expect(readme).toContain(claudeInstallLink("https://dawmain.davidzavada.cz/api/mcp"));
  });
});
