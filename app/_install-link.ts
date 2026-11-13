/**
 * Claude's install link for a custom connector: it opens the "Add custom
 * connector" dialog on claude.ai with the name and the address filled in
 * (the user still reviews and confirms, then signs in), so nobody has to
 * find the dialog in the settings or paste an address. The format is
 * Anthropic's own (claude.com/docs/connectors/building/directory-vs-custom,
 * "Custom connector install link"): `modal` must be add-custom-connector,
 * `connectorUrl` is the MCP address percent-encoded. A signed-out visitor is
 * asked to sign in first and then sees the same dialog. Pure.
 */
export function claudeInstallLink(endpoint: string, name = "Dawmain"): string {
  const query = new URLSearchParams({ modal: "add-custom-connector", connectorName: name, connectorUrl: endpoint });
  return `https://claude.ai/customize/connectors?${query}`;
}
