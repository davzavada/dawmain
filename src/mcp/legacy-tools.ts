/**
 * Calls by a tool name the server no longer lists.
 *
 * ns_get_decision, nss_get_decision, us_get_decision and justice_get_decision
 * became caselaw_get_decision {source, id} (11/2026). A client reads tools/list
 * when it connects and keeps it: a conversation opened before the change, a
 * connector whose list claude.ai or ChatGPT has cached, a directory reviewer's
 * saved test case — each still calls the old name, and the SDK answers "Tool
 * not found" (measured on the day of the change, from a session that had
 * connected an hour earlier). The server is stateless and cannot tell those
 * clients the list changed, so the old call is rewritten into the new one
 * before the request reaches the handler: same decision, same answer, and the
 * hit lines in that answer teach the new name.
 *
 * Only tools/call is touched; tools/list shows the new tool alone.
 */

type Json = Record<string, unknown>;

const CURRENT_GET = "caselaw_get_decision";

const LEGACY_GET: Record<string, { source: string; ids: readonly string[] }> = {
  ns_get_decision: { source: "ns", ids: ["unid"] },
  nss_get_decision: { source: "nss", ids: ["document_id"] },
  // ÚS took its sz or, instead, the ECLI — caselaw_get_decision reads either as id.
  us_get_decision: { source: "us", ids: ["sz", "ecli"] },
  justice_get_decision: { source: "justice", ids: ["uuid"] },
};

/** The call as the current tools take it, or null when the name is a current one. Pure. */
export function currentCall(name: string, args: unknown): { name: string; arguments: Json } | null {
  const legacy = LEGACY_GET[name];
  if (!legacy) return null;
  const given = args && typeof args === "object" && !Array.isArray(args) ? (args as Json) : {};
  const rest: Json = {};
  let id: unknown;
  for (const [key, value] of Object.entries(given)) {
    if (legacy.ids.includes(key)) {
      if (id === undefined && typeof value === "string" && value.trim()) id = value;
    } else {
      rest[key] = value;
    }
  }
  return { name: CURRENT_GET, arguments: { source: legacy.source, ...(id !== undefined ? { id } : {}), ...rest } };
}

/** One JSON-RPC message with a legacy tools/call rewritten; `changed` says whether it was. Pure. */
function rewriteMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { message, changed: false };
  const rpc = message as Json;
  const params = rpc.params as Json | undefined;
  if (rpc.method !== "tools/call" || !params || typeof params.name !== "string") return { message, changed: false };
  const current = currentCall(params.name, params.arguments);
  if (!current) return { message, changed: false };
  return { message: { ...rpc, params: { ...params, ...current } }, changed: true };
}

/** A JSON-RPC body (one message or a batch) with legacy calls rewritten, or null when nothing changed or it is not JSON. Pure. */
export function rewriteLegacyBody(body: string): string | null {
  // Cheap way out for every other request: none of the old names in the text.
  if (!Object.keys(LEGACY_GET).some((name) => body.includes(name))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const rewritten = messages.map(rewriteMessage);
  if (!rewritten.some((r) => r.changed)) return null;
  const out = rewritten.map((r) => r.message);
  return JSON.stringify(Array.isArray(parsed) ? out : out[0]);
}

/** The request as the handler should see it: a POST naming a legacy tool gets the current call in its body. */
export async function withCurrentToolNames(request: Request): Promise<Request> {
  if (request.method !== "POST") return request;
  let body: string;
  try {
    body = await request.clone().text();
  } catch {
    return request;
  }
  const rewritten = rewriteLegacyBody(body);
  if (rewritten === null) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  // The 2026-07-28 transport names the tool in a header too and refuses a request whose header and
  // body disagree (-32020, measured on the first deploy of this rewrite): the header follows the body.
  if (headers.has("mcp-name")) headers.set("mcp-name", CURRENT_GET);
  return new Request(request.url, { method: "POST", headers, body: rewritten, signal: request.signal });
}
