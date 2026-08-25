# dawmain-mcp-server

Vzdálený [MCP](https://modelcontextprotocol.io) server pro **právní rešerše**:
živě vyhledává v českých a evropských právních databázích — žádná vlastní data,
každý dotaz jde přímo do zdroje. Postavený na Next.js +
[`mcp-handler`](https://www.npmjs.com/package/mcp-handler), bezstavový
(Streamable HTTP), nasazený na Vercel.

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
| `curia_search` / `curia_get_document` | InfoCuria + Cellar | judikatura SDEU (C i T), texty dle CELEX/ECLI |
| `euipo_clw_search` / `euipo_clw_get_document` | EUIPO eSearchCLW | rozhodnutí odvolacích senátů, námitky, zrušení; extrakce textu z PDF |
| `euipo_guidelines_toc` / `euipo_guidelines_get_section` | guidelines.euipo.europa.eu | metodika EUIPO po sekcích |
| `upv_browse` / `upv_get_decision` | isdv.upv.gov.cz | správní a soudní rozhodnutí ÚPV |
| `dawmain_ping` | — | které nasazení odpovědělo |
| `dawmain_probe_sources` | — | diagnostika všech upstreamů z nasazené funkce; `include_raw` pro záchyt fixtures, `discover` pro hledání neověřených endpointů |

Známá omezení (přiznaná i v popisech nástrojů): NS adresuje jen prvních 900
výsledků dotazu (zužuj datem); justice.cz umí jen výpis po dnech; filtry EUIPO
běží client-side přes nejnovější záznamy; ÚPV je zatím jen procházení
kategorií.

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
layout → spusť probe).

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
3. Zavolej `dawmain_probe_sources` — u e-Sbírky ukáže, který host bere tvůj
   klíč (`esbirka-api` vs. `esbirka-api-gov`); vítěze zafixuj v env
   `ESBIRKA_API_BASE`.
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
