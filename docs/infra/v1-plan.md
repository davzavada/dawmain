# v1: lokální zrcadlo judikatury — databáze, API, backfill + denní sync

> **Instrukce pro lokální Claude Code (Mac s SSH na Proxmox).**
> Tento dokument je zadání. Pracuješ v repu `dawmain` na větvi
> `claude/kind-cray-w0w1iz`. Server: Proxmox VE 9, `ssh pve` (root, klíč
> `~/.ssh/claude_proxmox`), IP `192.168.0.50`, LAN `192.168.0.0/24`,
> brána `192.168.0.1`.
> Pravidla:
> 1. Postupuj po krocích z oddílu **Postup**, jeden krok za druhým. Na konci
>    každého kroku ukaž kontrolu a vysvětli česky, co se stalo, a počkej na
>    „pokračuj“.
> 2. Před každým destruktivním příkazem (`pct destroy`, mazání disků nebo
>    svazků, `DROP`, `TRUNCATE`, přepsání konfigurace hostitele) se zeptej.
>    Před migrací schématu udělej snapshot LXC `pg`.
> 3. Kód piš do repa podle oddílu **Kód v repu**, commituj po krocích a pushuj
>    na tuto větev; na server ho dostaň přes `git pull` v LXC `app`, ne ručním
>    kopírováním.
> 4. Hesla a tokeny nikdy necommituj; drž je v `/etc/mirror/env` na `app`
>    (práva 600) a v `~/.pgpass`.
> 5. Šetři zdroje: dodržuj tempo 1 req/s na zdroj a pilot 100 dokumentů
>    před plným backfillem. Když zdroj začne vracet 429/403, zastav ho a hlas to.
>    (24. 10.: pro backfill ÚS i NS zvýšeno na 4 req/s, 4 souběžně —
>    `MIRROR_US_RPS`, `MIRROR_US_CONCURRENCY`, `MIRROR_NS_…` v `/etc/mirror/env`;
>    NS po kalibraci 300 rozhodnutí bez jediné 5xx.)
> 6. Kde plán nesedí na realitu (jiná verze balíčku, endpoint nefunguje),
>    řekni to a navrhni úpravu, nehádej.

## Kontext

Dawmain dnes hledá v soudních databázích živě (`src/sources/*.ts`) a naráží na
jejich limity (NS jen 900 výsledků, NSS bez relevance, pomalý NALUS, justice.cz
padá na víceslovném fulltextu). Dlouhodobý cíl je vlastní zrcadlo, ke kterému
bude MCP server sahat per user. **v1 pokládá základy**: databáze, plnění daty
(backfill + denní sync) a jednoduché dotazovací API v domácí síti. Cílem v1 je
i to, aby celý řetězec byl srozumitelný a ověřitelný po krocích.

Stav (24. 10. 2026): Proxmox VE na Dell Latitude 5310 (16 GB RAM, 256 GB SSD),
`192.168.0.50`, no-subscription repo, upgrade, víko ignorováno, SSH z Macu
klíčem přes alias `pve`. Práce na stroji poběží z Claude Code na Macu.

Rozhodnutí: v1 = ÚS, NS, NSS, justice.cz; backfill i denní sync; e-Sbírka
zůstává živě. AI shrnutí, embeddingy, citační vazby a MCP napojení jsou až po v1.

## Princip: základ teď, zbytek z textu později

Syrové odpovědi zdrojů ani další metadata se **neukládají** (rozhodnutí
24. 10.). Ukládá se jen:

```
1. ZÁKLAD   soud, datum rozhodnutí, spisová značka, právní věta, TEXT
            + technická pole: zdroj a jeho ID, URL, ECLI, datum zveřejnění
   ↓ derive (chunky, tsvector, klíče sp. zn./§)
2. ODVOZENÉ vyhledávací index; později AI shrnutí, vektory, citátor
```

Doplněno 24. 10. po pilotu ÚS: do základu patří i **typ rozhodnutí**
(`decision_type`: rozsudek | usneseni | nalez | stanovisko | jine) a
**obrázky**, které zdroj do rozhodnutí vkládá (`decision_image`: bajty,
MIME, rozměry, pozice v textu), aby šlo celé rozhodnutí vykreslit. Začátek
prvního **odlišného stanoviska** (`decision_text.dissent_at`) je odvozený
z textu. Formátování písma se neukládá.

Vrstva 2 jde kdykoli přepočítat z textu (`reindex`, AI, vazby). Metadata,
která nejsou v textu (hesla, soudce, dotčené předpisy, věcný rejstřík),
budou později znamenat nové stažení dotčených rozhodnutí; to je vědomá cena
za jednoduché schéma. Od začátku se zapisuje `first_seen_at`,
`last_changed_at`, `gone_at` a `text_sha256` (změnu u zdroje pozná denní sync).

## Infrastruktura v1

| LXC (Debian 13, neprivilegovaný) | RAM | vCPU | Disk | Co běží |
| --- | --- | --- | --- | --- |
| `pg` | 8 GB | 4 | 120 GB | PostgreSQL 17 + pg_trgm (pgvector až v2) |
| `app` | 4 GB | 4 | 20 GB | Node 22, repo `dawmain`, systemd: `mirror-sync.timer`, `mirror-api.service` |

Host si nechá ~4 GB. Postgres: `shared_buffers` 2 GB, `effective_cache_size`
6 GB, `work_mem` 32 MB, `maintenance_work_mem` 1 GB, `random_page_cost` 1.1,
`default_toast_compression = lz4`, `jit = off`. Postgres poslouchá jen na
vnitřní síti Proxmoxu; API jen v LAN (`192.168.0.x`), bez tunelu ven.
Role: `mirror_owner` (migrace), `mirror_writer` (crawler), `mirror_reader` (API).
Záloha v1: snapshot LXC `pg` před každou migrací + noční `pg_dump` tabulky
`decision` (index jde přestavět z textu).

## Databáze — schéma `mirror`

- `decision(id, source ns|nss|us|justice, source_id, UNIQUE(source, source_id),
  url, court, case_number, case_numbers text[], decided_on, legal_sentence,
  ecli, published_on, text_sha256, parser_version,
  first_seen_at, last_seen_at, last_changed_at, gone_at)`. Identita: NS UNID,
  NSS číselné id, ÚS `sz`, justice UUID (sp. zn. není unikátní).

  | Pole | NS | NSS | ÚS | justice |
  | --- | --- | --- | --- | --- |
  | požadavky na rozhodnutí | WebPrint (fallback WebSearch) | detail + Text | řádek výsledků + GetText + GetAbstract | denní výpis + finaldoc |
  | soud | „Soud“ v detailu | ECLI / `soudsenat` (NSS vs. krajské) | Ústavní soud (+ senát/plénum ze `sz`) | `soud` / `courtCode` |
  | datum rozhodnutí | „Datum rozhodnutí“ | `datumvydanirozhodnuti` | výsledky / GetText | `datumVydani` |
  | spisová značka | „Spisová značka“ (může jich být víc) | `oznacenivecivcelku` | `lblRegistrySign` | `jednaciCislo` |
  | právní věta | „Právní věta“ (jen část) | `pravnivetaanv` (jen část) | GetAbstract (hlavně nálezy) | neexistuje |
  | text | tělo WebPrint | `/DokumentOriginal/Text` | `docContentHidden` | `verdictText` + `justificationText` |
  | ECLI | detail | detail | `nalusEcli` | výpis |
  | datum zveřejnění | „Zveřejněno na webu“ | `aktualizovano` (doplnit do `parseNssDetail`) | datum zpřístupnění (výsledky) | `datumZverejneni` |
- `decision_text(decision_id, body text, char_count, text_source)` — TOAST lz4.
  **Plný text je nejdůležitější a povinná část záznamu.** Rozhodnutí bez
  textu se neoznačí jako hotové: jde do `fetch_queue` a zkouší se znovu.
  Zdroj textu a pojistky (z existujícího kódu):
  - NS: `WebPrint`, při prázdném těle (`nsBodyMissing`) fallback `WebSearch`;
  - NSS: `/DokumentOriginal/Text` (UTF-16), při „N/A“ (`isNssMissingBody`)
    fallback `/DokumentOriginal/Html`;
  - ÚS: `docContentHidden` z GetText (`stripRtfMarkers`), fallback `DocContent`;
  - justice: `verdictText` + `justificationText`, jinak spojené odstavce
    `header/verdict/justification`; anonymizační značky zůstávají.
  `text_source` říká, která cesta text dala; `status` u zdroje ukazuje počet
  rozhodnutí bez textu a podezřele krátkých textů (< 500 znaků).
- `decision_chunk(decision_id, ord, char_start, char_end, tsv tsvector,
  ident_keys text[])`, **partition podle `source`**, GIN(tsv), GIN(ident_keys).
  Tsvector staví aplikace (Snowball, `'simple'`), stejně jako Vlastní zdroje;
  `ident_keys` dávají už ve v1 „kde se cituje sp. zn. / §“.
- Provoz: `sync_cursor(source, cursor jsonb)`, `sync_run(id, source, mode,
  started_at, finished_at, fetched, changed, failed, error)`,
  `fetch_queue(source, source_id, kind, attempts, next_try_at, last_error)`.
- Odhad: text ~10 GB (lz4), metadata < 1 GB, chunky + GIN ~15 GB;
  **celkem 25–30 GB** ze 120 GB.

## Crawler (`mirror backfill` / `mirror sync`)

Společné: na zdroj 1 req/s (NS max 2 souběžné), zdroje běží paralelně;
`fetchUpstream` (`src/sources/shared/http.ts`) s retry a backoffem na
429/5xx; idempotentní upsert; chyba dokumentu jde do `fetch_queue`, běh
nezastaví; každý běh = řádek `sync_run`. Před plným backfillem u každého
zdroje **pilot 100 dokumentů** a kontrola dat.

| Pořadí | Zdroj | Backfill | Denní sync (03:30) |
| --- | --- | --- | --- |
| 1 | ÚS ~90k | `Search.aspx` po čtvrtletích (`decidedFrom/To`, 80/str.) → sp. zn., datum, ECLI, zpřístupnění z řádků výsledků → `GetText.aspx` + `GetAbstract.aspx` (bez session); ~2 dny | `availableFrom = D-7` |
| 2 | NS ~164k | `WebSearch?ReadViewEntries&OutputFormat=JSON` (výčet UNID) → `WebPrint/{UNID}`, fallback `WebSearch/{UNID}`; ~2–3 dny | `$$WebSearch1` s `[datum_predani_na_web] >= D-7`, `SearchOrder=4` |
| 3 | NSS ~200k | ověřit id-walk `/DokumentDetail/Index/{id}` + `/DokumentOriginal/Text/{id}`; náhrada: hledání po dnech `datumvydanirozhodnuti`; ~3–4 dny | formulář s `aktualizovano >= D-7` |
| 4 | justice ~600k | `/api/opendata/{y}/{m}/{d}?page=N` (uložit výpis) → `/api/finaldoc/{uuid}`; ~4–5 dní | opendata posledních 14 dní |

Odhady jsou pro 1 req/s; zdroje jedou souběžně, celý backfill ~1 týden.
NS ReadViewEntries a NSS id-walk nejsou v kódu ověřené, první krok u nich je
živý test z domácí IP.

## API v1 (jen LAN, bearer token)

- `GET /v1/search?q=&source=&court=&from=&to=&case=&limit=` — fulltext
  (`buildTsQuery`) + identifikátory (`queryIdentKeys`), řazení `ts_rank_cd`,
  odpověď ve tvaru blízkém `AggregatedHit` (`src/mcp/tools/cz-caselaw.ts`)
  + úryvek se zvýrazněním.
- `GET /v1/decisions/:source/:id` — metadata, text (stránky po 45k jako
  `pageOrExcerpt`), odkaz na oficiální zdroj.
- `GET /v1/status` — per zdroj počty, poslední `sync_run`, fronta chyb.

Hono + `@hono/node-server`, role `mirror_reader`, timeout dotazu 5 s.

## Kód v repu `dawmain` (větev `claude/kind-cray-w0w1iz`)

```
src/mirror/db/migrations/0001_init.sql …   schéma mirror (runner scripts/db-migrate.mjs s parametrem --dir)
src/mirror/db/client.ts                     pg pool pro writer/reader
src/mirror/crawl/{us,ns,nss,justice}.ts     discover (výčet id) + fetch, režimy backfill/sync
src/mirror/map/{us,ns,nss,justice}.ts       výstup parse*() → řádek decision (5 polí + technická)
src/mirror/index.ts                         text → chunky + tsv + ident_keys
src/mirror/api/server.ts                    Hono API
scripts/mirror.ts                           CLI: migrate | backfill --source | sync | reindex | status | api
deploy/mirror/*.service, *.timer            systemd jednotky
docs/infra/README.md, proxmox.md            runbook a vysvětlení vrstev
```

Znovu použito: parsery `parseNalusResults`, `parseNalusDecision`,
`parseNalusAbstract` (`src/sources/nalus.ts`), `parseNsDecision`,
`parseNsSearch` (`ns.ts`), `parseNssResults`, `parseNssDetail`,
`isNssMissingBody` (`nss.ts`), `parseJusticeDecision`, `parseJusticeSearch`
(`justice.ts`), `fetchUpstream`, `CookieSession` (`shared/http.ts`),
`buildTsvector` (`src/files/index/tsv.ts`), `indexTerm`, `buildTsQuery`
(`src/files/text/analyze.ts`), `extractIdentKeys`, `queryIdentKeys`
(`src/files/index/identifiers.ts`), chunkování podle `src/files/index/derive.ts`,
migrace `scripts/db-migrate.mjs`, testy přes PGlite (`tests/helpers/pglite.ts`).
Spouštění TypeScriptu na serveru přes `tsx`. Nové závislosti: `hono`,
`@hono/node-server`, `tsx`. Next.js aplikace se nemění.

## Postup (každý krok končí kontrolou, kterou uvidíte)

1. **LXC `pg` a `app`**, Postgres, role, síť. Kontrola: `psql` z `app`.
2. **Schéma + migrace + CLI `migrate`**. Kontrola: tabulky v `psql`, testy v PGlite.
3. **ÚS pilot 100 rozhodnutí** (fetch → parse → index). Kontrola: `mirror status`,
   ruční porovnání 5 rozhodnutí s webem NALUS.
4. **API** nad pilotními daty. Kontrola: `curl` z Macu na `/v1/search`.
5. **Plný backfill ÚS**, pak piloty a backfill NS, NSS, justice.
6. **Denní sync** (systemd timer) + `fetch_queue` retry. Kontrola: druhý den
   nové řádky v `sync_run`.
7. **Ukázka zpětného doplnění**: `reindex` celého ÚS z uloženého textu bez
   jediného stažení.

## Ověření

- `npm test` (nové testy parse/derive/API proti PGlite a fixtures) a
  `npm run typecheck` zelené.
- Pilot 100 dokumentů na zdroj: 0 parse chyb, **100 % rozhodnutí s plným
  textem**, náhodný vzorek 5 textů porovnaný s webem od začátku do konce.
- Po backfillu: rozhodnutí bez textu < 0,5 % na zdroj a všechna ve frontě
  s důvodem.
- `/v1/search` vrací pro 5 známých dotazů očekávaná rozhodnutí (srovnání
  s `caselaw_search`), p95 < 500 ms.
- `/v1/status` po týdnu: denní běhy bez výpadku, fronta chyb se vyprazdňuje.
- `reindex` celého ÚS proběhne bez síťového provozu.

## Po v1 (mimo rozsah)

MCP přepínač per user (`features.localdb` v Clerku) + Cloudflare Tunnel;
AI vrstva (shrnutí, právní věty, hesla) přes frontu a Claude recurring task;
embeddingy (malý model, 384 dim) a hybridní hledání; citátor (`decision_ref`,
`provision_ref`); offline e-Sbírka z open-data dumpů; LXC `ops` s Claude Code
a omezeným tokenem; úprava README a právních textů před pilotem.
