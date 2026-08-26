import { createMcpHandler } from "mcp-handler";
import { SERVER_NAME, SERVER_VERSION } from "./config";
import { registerAllTools } from "./tools";

/**
 * The MCP server as a web-standard `(Request) => Promise<Response>` handler.
 *
 * `mcp-handler` serves the 2026-07-28 spec natively and falls back to
 * stateless Streamable HTTP for 2025-era clients from the same handler, so a
 * single route covers both client generations. Everything is stateless —
 * no sessions, no Redis — which is what makes it safe to run on serverless
 * functions that scale to zero.
 */
/**
 * Server-level instructions — the connector's "manual" that MCP clients hand
 * to the model at initialize, so it knows what this server can do without
 * guessing from tool names alone.
 */
const INSTRUCTIONS = `Czech & EU legal research server. Live queries into official databases — no local corpus, every result carries a public verification URL.

INTAKE — before searching, make sure you know (ask the user 2–3 focused questions if the request is vague; this is the ONLY situation where you stop to ask):
- the precise legal question or factual situation (broad but exactly defined beats vague),
- jurisdiction/scope (which courts? CZ / EU / both?) and the user's role/perspective (žalobce vs. žalovaný, zaměstnavatel vs. zaměstnanec…),
- the time frame as CONCRETE dates (never rely on "recently"/"loni" — translate them to dates yourself and say which you used),
- the expected output form (rešeršní memo, 5-point summary, argumentation, draft text, citations only…).

SOURCES → TOOLS
- Czech legislation (e-Sbírka): esbirka_search (full text; all_words/phrase/any_word, exclude_words, dates) → esbirka_get_act (metadata + version history) → esbirka_get_text (consolidated text as of any date; whole act, or one § via section:"§ 12").
- Czech supreme courts at once: cz_caselaw_search fans out to NSS + NS + Ústavní soud in parallel and names the follow-up tool per hit.
- Nejvyšší soud (civil/criminal): ns_search (full text, sp. zn., category A–E, dates; without dates auto-limited to last 12 months — say so when it applies) → ns_get_decision {unid}.
- Nejvyšší správní soud (administrative/tax/asylum): nss_search → nss_get_decision {document_id}.
- Ústavní soud: nalus_search (full text, citace, ECLI, judge, popular name, types, dates) → nalus_get_decision {sz or ecli}.
- Obecné soudy (rozhodnuti.justice.cz): justice_list_decisions lists by PUBLICATION date only (no server-side search exists) → justice_get_decision {uuid}.
- CJEU (InfoCuria live index, same-day decisions): curia_search (full text, case number, case/party name, ECLI, case status closed/pending, doc_type, court C/T, dates) → curia_get_document {ecli | celex | case_number | logic_doc_id}; Czech texts usually via language:"cs".
- EUR-Lex/Cellar: eurlex_search (titles + CELEX/ECLI/types/dates — NOT full text; full-text CJEU search = curia_search) → eurlex_get_document {celex} (32016R0679 = GDPR).
- EUIPO decisions: euipo_clw_search → euipo_clw_get_document {pdf_url}. EUIPO Guidelines: euipo_guidelines_toc (drill via parent_topic_id) → euipo_guidelines_get_section {topic_id}. ÚPV: upv_browse → upv_get_decision {p_id}.
- Diagnostics: dawmain_ping, dawmain_probe_sources (when a source misbehaves).

READING DOCUMENTS — token economy
1. After a search, READ the promising documents with the matching *_get_* tool and let what you read drive the next step. Do not argue from snippets alone.
2. Documents come in ~45k-character pages. Fetch ONLY what you need: hunting for specific passages (a cited case, "safe harbour", one §) → use find:"term" and get targeted excerpts instead of pages; doing a close reading → fetch the remaining pages. Either way continue on your own — NEVER ask the user whether to keep reading.
3. Czech sources expect Czech queries; CJEU/EUIPO work best in English. language:"cs" falls back to English when no Czech version exists.

OUTPUT RULES
4. Cite every authority in the running text with sp. zn./ECLI + date + the URL from the hit (links point at the decision text) so the user can verify with one click.
5. Render every verbatim quotation (právní věta, passage from a decision) as a Markdown blockquote, immediately followed by its citation.
6. An empty result is not an error — follow the hint in the response (broaden dates, other keywords, different tool) and say what you changed.`;

export const mcpHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
    verboseLogs: process.env.VERCEL_ENV !== "production",
  },
);
