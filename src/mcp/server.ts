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

SOURCES → TOOLS
- Czech legislation (e-Sbírka): esbirka_search (full text; match modes all_words/phrase/any_word, exclude_words, dates) → esbirka_get_act (metadata + version history) → esbirka_get_text (consolidated text as of any date; whole act or one § via section:"§ 12").
- Czech supreme courts, one query: cz_caselaw_search fans out to NSS + NS + Ústavní soud in parallel and names the follow-up tool per hit.
- Nejvyšší soud (civil/criminal): ns_search (full text, sp. zn., category A–E, dates; without dates auto-limited to last 12 months — the court's server rejects unbounded queries) → ns_get_decision {unid}.
- Nejvyšší správní soud (administrative/tax/asylum): nss_search (full text, čj., dates) → nss_get_decision {document_id}.
- Ústavní soud: nalus_search (full text, citace, ECLI, judge, popular name, types, dates) → nalus_get_decision {sz or ecli}.
- Obecné soudy (rozhodnuti.justice.cz): justice_list_decisions lists by PUBLICATION date only (no server-side search exists) → justice_get_decision {uuid}.
- CJEU (InfoCuria live index, same-day decisions): curia_search (full text of judgments/opinions, case number, case/party name, ECLI, case status closed/pending, doc_type, court C/T, dates) → curia_get_document {ecli | celex | case_number | logic_doc_id} — Czech versions usually available via language:"cs".
- EUR-Lex/Cellar (official Publications Office): eurlex_search (titles + CELEX/ECLI/types/dates — NOT full text; for full-text CJEU search use curia_search) → eurlex_get_document {celex} (e.g. 32016R0679 = GDPR).
- EUIPO decisions (BoA, oppositions, cancellations): euipo_clw_search (metadata filters, newest-first) → euipo_clw_get_document {pdf_url} (extracts PDF text).
- EUIPO Examination Guidelines: euipo_guidelines_toc (drill via parent_topic_id) → euipo_guidelines_get_section {topic_id}.
- ÚPV (Czech IP office): upv_browse (category tree) → upv_get_decision {p_id}.
- Diagnostics: dawmain_ping (which deployment answers), dawmain_probe_sources (health of all upstreams; use when a source misbehaves).

WORKING RULES
1. Search → read → continue: after any *_search, fetch the promising documents with the matching *_get_* tool and base further research on what you read. Do not stop at snippets.
2. Documents come in ~60k-character pages. When has_more is true, IMMEDIATELY fetch the next page(s) — never ask the user whether to continue reading.
3. Czech sources expect Czech queries; CJEU/EUIPO work best in English. Requesting a text with language:"cs" falls back to English when no Czech version exists.
4. Every hit carries a public URL — cite it so findings can be verified.
5. Empty result ≠ error: follow the hint in the response (broaden dates, change keywords, different tool).`;

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
