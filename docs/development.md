# Vývojová dokumentace

Technické zázemí serveru Dawmain — nástroje, architektura, vývoj a nasazení.
Uživatelský popis je v [README](../README.md).

## Nástroje

| Nástroj | Zdroj | Co dělá |
| --- | --- | --- |
| `esbirka_search` | e-Sbírka | fulltext v Sbírce zákonů |
| `esbirka_get_act` | e-Sbírka | metadata a historie znění předpisu |
| `esbirka_get_text` | e-Sbírka | konsolidovaný text k datu — celý předpis, nebo jeden § |
| `ns_search` / `ns_get_decision` | rozhodnuti.nsoud.cz | judikatura Nejvyššího soudu |
| `nss_search` / `nss_get_decision` | vyhledavac.nssoud.cz | judikatura NSS |
| `nalus_search` / `nalus_get_decision` | nalus.usoud.cz | judikatura Ústavního soudu |
| `cz_caselaw_search` | NSS + NS + ÚS | jeden dotaz paralelně přes tři vrcholné soudy |
| `justice_list_decisions` / `justice_get_decision` | rozhodnuti.justice.cz | obecné soudy — výpis po dnech zveřejnění (zdroj nemá server-side vyhledávání) |
| `curia_search` / `curia_get_document` | InfoCuria + Cellar | FULLTEXT judikatury SDEU (C i T) přes vlastní index soudu; texty dle CELEX/ECLI |
| `eurlex_search` / `eurlex_get_document` | Cellar SPARQL (Publications Office) | EU legislativa + judikatura dle názvů, CELEX/ECLI, typů a dat; texty z oficiálního Cellaru |
| `euipo_clw_search` / `euipo_clw_get_document` | EUIPO eSearchCLW | rozhodnutí odvolacích senátů, námitky, zrušení; extrakce textu z PDF |
| `euipo_guidelines_toc` / `euipo_guidelines_get_section` | guidelines.euipo.europa.eu | metodika EUIPO po sekcích |
| `dawmain_ping` | — | které nasazení odpovědělo |
| `dawmain_probe_sources` | — | diagnostika všech upstreamů z nasazené funkce; `include_raw` pro záchyt fixtures, `discover` pro hledání neověřených endpointů |

Známá omezení (přiznaná i v popisech nástrojů): NS adresuje jen prvních 900
výsledků dotazu (zužuj datem); justice.cz umí jen výpis po dnech; filtry EUIPO
běží client-side přes nejnovější záznamy. **ÚPV** (isdv.upv.gov.cz) zahazuje
spojení z datacentrových IP (ověřeno živě z regionu fra1 na obou hostech),
takže nástroje `upv_browse`/`upv_get_decision` nejsou registrované — kód i
probe kanárky (`upv`, `upv-legacy`) zůstávají, kdyby se zdroj zpřístupnil.

## Architektura

```
app/api/mcp/route.ts        HTTP route + bearer autentizace
src/mcp/tools/<zdroj>.ts    tenké MCP nástroje (schema → klient → tvar odpovědi)
src/sources/<zdroj>.ts      klient zdroje; fetchX() (I/O) oddělené od parseX() (pure)
src/sources/shared/         fetchUpstream, CookieSession, chybová taxonomie, char-paging
docs/research/*.json        verbatim rešerše endpointů všech zdrojů
tests/                      unit testy parserů proti fixtures
scripts/smoke.mjs           end-to-end test po drátě (obě generace protokolu)
scripts/fetch-fixtures.mjs  stáhne reálné fixtures z veřejných GitHub rep
```

Zásady: každý nástroj má `annotations` (vše read-only), stránkování
(`limit`/`offset` či `page`, `has_more`), `structuredContent` + čitelný text a
chybové hlášky, které říkají, co zkusit jinak (`PARSE_DRIFT` = upstream změnil
layout → spusť probe). Rychlost: opakovaná identická volání jdou z per-instance
cache (5 min hledání, 10 min texty rozhodnutí — stránka 2 dokumentu už text
nestahuje znovu) a vícestránkové smyčky (e-Sbírka §-scan, justice day-walk,
vícedílné dokumenty v Cellaru) běží v malých paralelních dávkách — stejný
počet requestů na upstream, zlomek času.

## Vývoj

```bash
npm install
npm run dev          # http://localhost:3000, endpoint /api/mcp
npm test             # unit testy parserů (fixtures, bez sítě)
npm run typecheck
npm run smoke        # po drátě proti běžícímu serveru (bez upstreamů)
```

Pozor: soudní weby nejsou dostupné z každé sítě (CI, sandboxy). Integrační
ověření se dělá **proti nasazení**:

```bash
MCP_URL=https://<deployment>.vercel.app/api/mcp MCP_BEARER_TOKEN=… npm run smoke
MCP_URL=… MCP_BEARER_TOKEN=… SMOKE_LIVE=1 npm run smoke   # + reálné dotazy do zdrojů
```

## Nasazení na Vercel

Repo je propojené přes Git integraci — push nasadí preview, merge do `main`
produkci. Bez `vercel.json`; Next.js si Vercel detekuje sám.

**Po prvním nasazení:**

1. *Project Settings → Environment Variables*: `MCP_BEARER_TOKEN`,
   `ESBIRKA_API_KEY` (viz `.env.example`); *Functions → Region*: `fra1`.
   Po změně env je potřeba Redeploy.
2. Spusť smoke proti nasazení (viz výše), pak `SMOKE_LIVE=1`.
3. Zavolej `dawmain_probe_sources` — ověří všech 9 upstreamů z nasazení.
4. `dawmain_probe_sources {discover: true}` vypíše (a) kandidátní search
   endpoint SPA justice.cz, (b) skutečná pole formuláře NSS — obojí slouží
   k doladění `src/sources/nss.ts` a k budoucímu `justice_search`.
5. Volitelné jednorázovky v prohlížeči (DevTools → Network): zachytit XHR
   filtrovaného hledání na rozhodnuti.justice.cz a na EUIPO eSearchCLW —
   odemkne server-side filtry.

## Připojení klienta

```bash
claude mcp add --transport http dawmain https://<deployment>.vercel.app/api/mcp --header "Authorization: Bearer <token>"
```

```json
{
  "mcpServers": {
    "dawmain": {
      "type": "http",
      "url": "https://<deployment>.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Výkon a šetrnost ke zdrojům

- Neměnná data se cachují per warm instance: edice/TOC/sekce EUIPO Guidelines
  (1 h), metadata a historie znění e-Sbírky (10 min), NSS handshake a EUIPO
  download cookies (10 min).
- NS: deterministická 500 se neopakuje — místo retry se zužuje datové okno
  (bez zadaných dat automaticky 12 měsíců → 90 dnů).
- Client-side filtry EUIPO dělají pauzu 300 ms mezi stránkami; procházení
  justice.cz je stropované 20 stránkami na volání, scan § v e-Sbírce 15
  stránkami; vše končí hned po naplnění limitu.
- Texty dokumentů se vracejí po stránkách 45 000 znaků (bezpečně pod limity klientů) — typické rozhodnutí
  v jedné odpovědi; delší texty nesou pokyn agentovi pokračovat bez ptaní.
- Timeouty: výchozí 15 s/request; odchylky: NSS POST 25 s, Cellar retrieval 25 s,
  Cellar SPARQL 30 s, e-Sbírka SPARQL 20 s, EUIPO PDF 30 s. Celá invokace ≤ 60 s.

## Autentizace

S nastaveným `MCP_BEARER_TOKEN` vrací endpoint bez tokenu `401`. Bez něj je
veřejný — nedoporučeno: server pak komukoli zprostředkuje dotazy do databází
z tvé infrastruktury. Na plné OAuth 2.1 jsou v `mcp-handler` připravené
`withMcpAuth` a `protectedResourceHandler`.

## Přidání zdroje

1. `src/sources/<zdroj>.ts` — klient s odděleným `fetchX`/`parseX`.
2. `src/mcp/tools/<zdroj>.ts` — `register<Zdroj>(server)`.
3. Řádka v `src/mcp/tools/index.ts`, kanárek do `src/mcp/tools/probe.ts`,
   testy do `tests/`, jméno nástroje do `EXPECTED_TOOLS` v `scripts/smoke.mjs`.
