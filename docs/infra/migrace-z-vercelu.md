# Migrace z Vercelu na Proxmox

Plán přesunu webu a MCP serveru Dawmain z Vercelu (Hobby) na domácí Proxmox
([proxmox.md](proxmox.md)). Cíl: všechno připravit a ověřit předem, aby
**přepnutí bylo jedna změna DNS záznamu** a služba při něm nepřestala
odpovídat.

Stav plánu (16. 11. 2026): fáze 0 a 1 hotové a nasazené na CT `web`, z fáze 2
tunel, zkušební adresa `dawmain-novy` a WAF výjimka; skripty pro přesun
databáze (`migrate-db.sh`) a generálku (`rehearsal.sh`) vyzkoušené; zbytek
čeká (viz níže „Odchylky od plánu“ a „Co zbývá do přepnutí“). Kód běží v
`main`, Vercel se nezměnil.

### Změna pořadí: databáze se stěhuje při přepnutí

Původně měl domácí server po přepnutí domény ještě týden číst Neon. Nově se
**databáze stěhuje domů v rámci přepnutí** (jedna sekvence, fáze 5) a domácí
instance už teď používá domácí databázi `files` (do přepnutí jen zkušební
data). Důvod — nález při importu proměnných:

- **`vercel env pull` vrací u proměnných označených jako *sensitive*
  doslova `[SENSITIVE]`** a hodnotu z Vercelu nejde získat zpět. Týká se to
  URL role `dawmain_app` v Neonu i dalších tajemství. Souběh nad Neonem by
  proto vyžadoval nové heslo v Neonu (zásah do produkce). Na jednorázovou
  kopii dat stačí **connection string vlastníka** z konzole Neonu.
- Tajemství, která chybí, se berou ze serveru (`CRON_SECRET`,
  `AI_GATEWAY_API_KEY`, `MIRROR_API_TOKEN`);
  `FILES_DATABASE_URL` vždy z `/root/files-db-urls.env` (domácí databáze);
  `CREDENTIALS_SECRET` z Vercelu nejde získat → `import-env.sh
  --new-credentials-secret` vytvoří nový: kdo měl připojené Zotero, připojí
  ho jednou znovu. `CLERK_WEBHOOK_SIGNING_SECRET` jde znovu zobrazit v Clerku
  (*Webhooks → endpoint → Signing Secret*) a doplnit ručně.
- **Produkce na Vercelu nemá `CRON_SECRET` ani
  `CLERK_WEBHOOK_SIGNING_SECRET`.** Endpoint cronu i webhooku pak vrací 503,
  takže denní údržba tam nejspíš **nikdy neběžela** a smazání účtu v Clerku
  se do Vlastních zdrojů nepropsalo. První běh cronu doma proto udělá všechny
  odložené úklidy najednou — viz „První běh cronu doma“ ve fázi 5.

### Odchylky od plánu

- **Rozhodnutí 16. 11. (2):** přepíná se **bez zálohy mimo stroj a bez externího
  dohledu** — databáze je prázdná; obojí doplnit, než se nahromadí dokumenty
  uživatelů (`backup-files.sh` a timer jsou připravené, chybí jen úložiště).
  Generálka přihlášení v prohlížeči se nepovedla (prohlížeč obcházel `/etc/hosts`)
  a byla vynechána: ověřeno jen, že Clerk klíč platí a OAuth discovery odpovídá;
  přihlášení se poprvé vyzkouší hned po přepnutí.
- **Rozhodnutí 16. 11.:** sdílený přístupový kód (`MCP_BEARER_TOKEN`) se domů
  nepřenáší — po přepnutí platí jen přihlášení přes Clerk; konektory nastavené
  na starý kód se přihlásí účtem. Zotero se doma nastaví znovu později (bez
  `ZOTERO_OAUTH_*` je vypnuté) a `CREDENTIALS_SECRET` je nový. Data z Neonu se
  nepřenášejí, pokud se neukáže, že tam něco je (`migrate-db.sh` je připravený;
  Neon zůstává 14 dní nedotčený).

- `pg` se **nezmenšoval**: limit paměti není rezervace a host měl volných ~10 GB
  (s cache). Vrátit se k tomu, jen když začne docházet paměť.
- Thin pool je na ~45 %, ne skoro plný. Roste snapshot `pre-0019-structure`
  (120 GB, thin) — smazat, až nebude potřeba.
- API zrcadla poslouchá jen na LAN adrese, takže web ho volá přes
  `http://192.168.0.52:8080`, ne přes vnitřní síť; restart zrcadla odpadl.
- Za tunelem vidí Node prostý `http`: OAuth discovery proto doma bere
  `PUBLIC_URL` (bod 0.5).
- `deploy.sh` zapisuje `release.env` (`GIT_SHA`), který unit načítá, aby
  `dawmain_ping` ukazoval commit i za běhu.
- Cron unit: v `ExecStart` musí být `%%s`, ne `%s` (systemd by ho nahradil
  shellem uživatele) — zachytil test, opraveno.

### Co zbývá do přepnutí

Na uživateli, z kořene repozitáře na Macu:

```bash
# 1. produkční proměnné (sensitive doplnit ručně do souboru, viz výše)
npx vercel env pull --environment=production .env.prod
deploy/web/import-env.sh .env.prod --dry-run [--new-credentials-secret]   # jen názvy klíčů
deploy/web/import-env.sh .env.prod [--new-credentials-secret]             # instalace, přebuild, při chybě návrat
rm .env.prod
# 2. zkouška přesunu dat z Neonu (owner, přímé spojení bez -pooler; nic se nevypisuje)
read -rs SOURCE_DATABASE_URL && export SOURCE_DATABASE_URL
deploy/web/migrate-db.sh --check          # verze, migrace, schéma, počty řádků — nic nemění
deploy/web/migrate-db.sh --replace        # zkušební kopie; změřit čas
unset SOURCE_DATABASE_URL
# 3. generálka (fáze 4), záloha mimo stroj (fáze 3), pak
deploy/web/preflight.sh                   # musí říct GO
```

`import-env.sh` byl vyzkoušen s vymyšleným souborem: rozbitý soubor shodí
přebuild, nic se nepřepne a původní `/etc/dawmain/env` se vrátí bajt po bajtu.
`migrate-db.sh` byl vyzkoušen proti pomocné databázi v CT `pg` (viz fáze 5).

Dál na uživateli: zápis Cloudflare (WAF výjimka rozšířit na `dawmain`, v
přepnutí změnit CNAME); záloha mimo stroj (účet R2 / disk) a dohled
(Healthchecks / UptimeRobot).

## Proč to půjde plynule

Tři vlastnosti dnešního Dawmainu, o které se plán opírá:

1. **MCP je bezstavové** (`src/mcp/server.ts`): žádné relace v paměti. Je
   jedno, které nasazení na který požadavek odpoví.
2. **Stav je mimo hosting**: účty a OAuth v Clerku, klíče Zotera v
   metadatech Clerku; Vlastní zdroje a počitadla v jedné databázi, kterou
   jde zkopírovat skriptem (`migrate-db.sh`) za pár minut.
3. **Doména se nemění** a její DNS je už na Cloudflare. Konektory uživatelů,
   Clerk (produkční instance, OAuth, webhook) ani callback Zotera se
   nepřenastavují; vydané tokeny platí dál.

Z toho plyne pořadí: domácí nasazení běží nejdřív **souběžně** s Vercelem
nad vlastní (zkušební) databází, při přepnutí se Vercel přepne jen na čtení,
data se zkopírují z Neonu domů a hned nato se změní DNS. Souběh nad Neonem
(původní plán) padl na tom, že URL aplikační role z Vercelu nejde získat
(viz „Změna pořadí“).

Clerk zůstává beze změny po celou dobu i potom.

## Web a MCP jsou jedna aplikace

Stěhuje se celý Next.js projekt, ne jen `/api/mcp`: úvodní stránka,
`/podminky`, `/soukromi`, `/vlastni-zdroje`, `/sprava`, návod
`/dawmain-reserse.md`, ikony i `/api/status`. Všechno obslouží tatáž služba
`dawmain-web` v CT `web`; zvláštní webhosting není potřeba. Co se pro web
mění oproti Vercelu:

- **Statické soubory** (`/_next/static/*`, `public/`): servíruje je Next ze
  standalone vydání (`deploy.sh` je tam musí zkopírovat, jinak web naběhne
  bez stylů) a Cloudflare je cachuje na okraji sám podle přípony.
- **Stránky (HTML)**: jsou předgenerované, ale Cloudflare HTML ve výchozím
  stavu necachuje — každé zobrazení dojde domů. Při dnešním provozu to
  stačí a nechávám to tak: uložení textů ve Správě se pak projeví hned, bez
  mazání cache na Cloudflare. Když server spí nebo padne, web je dole
  spolu s MCP (Vercel statické stránky držel na CDN nezávisle).
- **`/api/status`** s hodinovou revalidací drží cache Nextu místo CDN
  Vercelu; chování navenek stejné.
- **Preview nasazení** pro každou větev zaniknou; náhradou je zkušební
  adresa `dawmain-novy` (fáze 2) nebo `npm run dev`.
- **Vercel Analytics / Speed Insights** projekt nepoužívá, nic nevypadne.

Kontroly webu jsou součástí fáze 2 (vzhled, hlavičky, ikony přes zkušební
adresu) a fáze 4 (přihlášení a Vlastní zdroje na pravé doméně).

## Cílový stav

```
Internet → Cloudflare (DNS + proxy) → Tunnel dawmain-databaze (jen odchozí)
   ├─ dawmain.davidzavada.cz          → CT 103 web  :3000  (Next.js, systemd)
   └─ dawmain-databaze.davidzavada.cz → CT 102 app  :8080  (API zrcadla, beze změny)

CT 103 web ── vmbr1 ──► CT 101 pg   databáze `files` (data od přepnutí; do té doby zkušební)
CT 103 web ── vmbr1 ──► CT 102 app  API zrcadla po vnitřní síti (bez Cloudflare Access)
```

| CT | Jméno | RAM / vCPU / disk | LAN | Vnitřní |
| --- | --- | --- | --- | --- |
| 101 | `pg` | **6 GB** (z 8) / 4 / 120 GB | 192.168.0.51 | 10.10.10.2 |
| 102 | `app` | 4 GB / 4 / 20 GB | 192.168.0.52 | 10.10.10.3 |
| 103 | `web` (nový) | 3 GB / 4 / 12 GB | 192.168.0.53 | 10.10.10.4 |

Paměť: 16 GB = 6 + 4 + 3 + ~3 pro hostitele. `shared_buffers` 2 GB zůstává,
`effective_cache_size` klesne na 4 GB. Disk: thin pool je alokovaný skoro
celý, CT `web` ho přealokuje — před založením zkontrolovat `lvs` (Data%) a
dál ho hlídat (viz monitoring ve fázi 3).

## Fáze 0 — kód: běh mimo Vercel (větev, PR do `main`)

Úpravy jsou zpětně kompatibilní: tentýž commit běží na Vercelu i doma.

| # | Soubor | Změna |
| --- | --- | --- |
| 0.1 | `src/mcp/auth.ts` | **Bezpečnostní.** `authRequired()` dnes vynucuje přihlášení jen podle `process.env.VERCEL`. Doma by překlep v proměnné otevřel endpoint všem. Nově: vynuceno i při `DAWMAIN_REQUIRE_AUTH=1`; domácí služba ho nastavuje napevno v unit souboru. Test. |
| 0.2 | `app/page.tsx`, `src/mcp/tools/files.ts` | `VERCEL_PROJECT_PRODUCTION_URL` → nejdřív `PUBLIC_URL` (např. `https://dawmain.davidzavada.cz`), pak dosavadní hodnota. |
| 0.3 | `src/mcp/tools/ping.ts`, `src/mcp/server.ts` | `VERCEL_ENV` / `VERCEL_REGION` / `VERCEL_GIT_COMMIT_SHA` → nejdřív `APP_ENV`, `APP_REGION`, `GIT_SHA` (doplní deploy skript). `dawmain_ping` tak ukáže, **které nasazení odpovídá** — hlavní nástroj kontroly při přepnutí. |
| 0.4 | `next.config.ts` | `output: "standalone"` jen při `NEXT_OUTPUT=standalone` (nastaví `deploy.sh`), takže build na Vercelu zůstává stejný. Verzi vydání nese `NEXT_DEPLOYMENT_ID`, který Next čte sám. `SKILL.md` se do standalone výstupu přibalí (ověřeno). |
| 0.5 | `src/zotero/web.ts`, `src/files/guards.ts`, `src/mcp/auth.ts` | Čtou `x-forwarded-host` (a `mcp-handler` i `x-forwarded-proto`). Vercel ho přepisuje, Cloudflare Tunnel ho od klienta propustí. Nové `TRUST_FORWARDED_HOST=0` (doma; výchozí zůstává „důvěřovat“, aby se na Vercelu nic nezměnilo) bere jen `Host`. **Nález při ověřování:** za tunelem vidí Node prostý `http` a žádný `x-forwarded-host`, takže by OAuth discovery MCP klientům nabídl `http://…`. Doma proto adresu pro OAuth (metadata i `WWW-Authenticate`) určuje pevné `PUBLIC_URL`. |
| 0.6 | `src/sources/mirror.ts` | Beze změny kódu — Access hlavičky jsou už volitelné; doma se nastaví `MIRROR_API_URL=http://10.10.10.3:8080`. API zrcadla musí poslouchat i na `10.10.10.3` (`MIRROR_API_HOST`), ověřit. |
| 0.7 | `src/mcp/usage.ts`, `src/files/db/client.ts` | `waitUntil` a `attachDatabasePool` mimo Vercel nic nedělají a kód s tím počítá. Zůstávají do úklidu (fáze 6); jen ověřit testem, že bez Vercelu nepadají. |
| 0.8 | `deploy/web/` | Nové soubory: `dawmain-web.service`, `dawmain-cron.service` + `.timer`, `deploy.sh`, `backup-files.sh` (viz fáze 1–3). |
| 0.9 | `.env.example`, `docs/development.md` | Nové proměnné a oddíl „Nasazení doma“. |

AI Gateway: na Vercelu se ověřuje přes OIDC, doma přes `AI_GATEWAY_API_KEY`
(kód už obojí umí). Bez klíče jdou metadata z heuristik — funkční, jen horší.

Hotovo, když: `npm test`, `npm run typecheck` a `npm run build` projdou,
Vercel preview z větve se chová jako dřív a `npm run start` lokálně se
`DAWMAIN_REQUIRE_AUTH=1` bez klíčů vrací na `/api/mcp` 401.

## Fáze 1 — kontejner `web` a služba

1. Snapshot nic nestojí, ale `pg` se zmenšuje: `pct set 101 -memory 6144`,
   upravit `effective_cache_size`, restart Postgresu (zrcadlo na pár sekund).
2. `pct create 103` — Debian 13, neprivilegovaný, `nesting=1`, start po bootu,
   `eth0` 192.168.0.53, `eth1` 10.10.10.4, zóna `Europe/Prague`. Node 22.
3. Uživatel `dawmain`, repo v `/opt/dawmain-web/repo`, vydání v
   `/opt/dawmain-web/releases/<sha>`, symlink `current`.
4. `/etc/dawmain/env` (600): všechny proměnné produkce z Vercelu
   (`vercel env pull` na Macu, přenést ručně, nikdy necommitovat) plus
   `PUBLIC_URL`, `APP_ENV=production`, `APP_REGION=home`,
   `DAWMAIN_REQUIRE_AUTH=1`, `AI_GATEWAY_API_KEY`, `MIRROR_API_URL` na
   vnitřní adresu; **bez** `MIRROR_CF_ACCESS_*`. `FILES_DATABASE_URL` =
   domácí databáze `files` (`import-env.sh` ji bere z `/root/files-db-urls.env`).
   `NEXT_PUBLIC_*` musí být přítomné už při buildu.
5. `deploy.sh <ref>`: `git fetch`, checkout do nového adresáře vydání,
   `npm ci`, `GIT_SHA=… npm run build`, zkopírovat `public` a
   `.next/static` do standalone, spustit smoke proti vydání na vedlejším
   portu, přepnout `current`, `systemctl restart dawmain-web`, nechat
   posledních 5 vydání. Když smoke neprojde, nepřepíná.
6. `dawmain-web.service`: `node server.js` ze standalone, `HOSTNAME=0.0.0.0`,
   `PORT=3000`, `EnvironmentFile=/etc/dawmain/env`, `Restart=on-failure`,
   `TimeoutStopSec=30` (doběhnou rozdělané požadavky), stejné zpevnění jako
   `mirror-api.service`.
7. Firewall CT: port 3000 jen z `app` (cloudflared) a z LAN pro testy.

Paměť při buildu: když `next build` ve 3 GB neprojde, dočasně
`pct set 103 -memory 5120`, nebo build na Macu a přenos hotového vydání.

Hotovo, když: z Macu `MCP_URL=http://192.168.0.53:3000/api/mcp npm run smoke`
projde s bearer tokenem i se `SMOKE_LIVE=1`, a `dawmain_probe_sources`
z domácí adresy vidí všechny zdroje (viz riziko „domácí IP“).

## Fáze 2 — tunel a zkušební adresa

1. Do `/etc/cloudflared/config.yml` (CT `app`) přidat před závěrečné 404:
   `dawmain.davidzavada.cz` a `dawmain-novy.davidzavada.cz` →
   `http://10.10.10.4:3000`. `ingress validate`, restart `cloudflared`.
   Pravidlo pro hlavní doménu je tím připravené; dokud na tunel nemíří DNS,
   nic se neděje.
2. DNS: `dawmain-novy` CNAME → `<id tunelu>.cfargotunnel.com`, proxied.
   **Bez** Cloudflare Access (MCP je veřejné, chrání ho Clerk / token).
3. Cloudflare pro obě jména: vypnout Bot Fight Mode nebo přidat WAF výjimku
   pro `/api/*` a `/.well-known/*` (jinak Cloudflare zastaví servery Claude
   a ChatGPT, které se chovají jako boti); žádné cachování `/api/*`; SSL
   Full; Rocket Loader a Email Obfuscation vypnout (mění HTML).
4. Kontroly přes zkušební adresu: smoke s bearer tokenem; `dawmain_ping`
   ukazuje `region: home`; dlouhé volání (NALUS) se nepřeruší a odpověď se
   streamuje; `/.well-known/oauth-protected-resource` vrací adresy podle
   hostitele požadavku; hlavičky z `next.config.ts` dorazí.
5. Konektor v Claude na `dawmain-novy…/api/mcp` s bearer tokenem: skutečná
   rešerše přes domácí server.

Na zkušební adrese **nefunguje přihlášení Clerkem** (produkční instance je
vázaná na `dawmain.davidzavada.cz`). To je záměr; Clerk ověří generálka.

## Fáze 3 — provoz kolem: cron, zálohy, dohled

1. **Cron**: `dawmain-cron.timer` denně 04:00 Europe/Prague →
   `curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/files`.
   Nainstalovaný, ale **vypnutý až do přepnutí** a do kontroly prvního běhu
   (fáze 5). Na Vercelu cron fakticky neběží (chybí `CRON_SECRET`) a tak to
   zůstane.
2. **Záloha Vlastních zdrojů** (povinná před přepnutím — `preflight.sh` bez ní
   řekne NO-GO; timer zapnout hned, zálohuje zatím zkušební data; skript
   `deploy/web/backup-files.sh` je vyzkoušený s lokálním restic repem včetně obnovy
   do pomocné databáze, chybí jen vzdálené úložiště a přihlašovací údaje; běží pod
   `files_owner`, protože tabulky jsou pod RLS):
   noční `pg_dump -Fc files` → šifrovaně (restic) mimo stroj — Cloudflare R2
   nebo disk na Macu; držet 7 denních + 4 týdenní. Jednou ročně zkouška
   obnovy. Neon měl obnovu k bodu v čase; doma ji nahrazuje tohle, a je to
   jediná kopie dat uživatelů mimo notebook.
3. **Dohled**: externí kontrola `https://dawmain.davidzavada.cz/api/status`
   každých 5 min s e-mailem (UptimeRobot / Healthchecks.io); cron a záloha
   po úspěchu pingnou Healthchecks (ozve se, když neproběhnou); týdenní
   kontrola `lvs` Data% > 80 % → e-mail.
4. **Logy**: `journalctl -u dawmain-web`, uchování 30 dní; žádné argumenty
   volání se nelogují (stejně jako dnes, `/soukromi`).
5. **Výpadky**: BIOS „zapnout po obnovení napájení“, baterie notebooku jako
   UPS, kontejnery startují po bootu, tunel se obnoví sám. Vyzkoušet
   vytažením ze zásuvky a restartem hostitele.

## Fáze 4 — generálka na skutečné doméně

Účel: ověřit Clerk, nahrávání a Zotero na `dawmain.davidzavada.cz` dřív, než
se doména přepne pro všechny.

1. `deploy/web/rehearsal.sh start` — v CT `web` Caddy na `192.168.0.53:443`
   pro `dawmain.davidzavada.cz` s vlastní CA (`tls internal`, žádný token
   Cloudflare ani DNS) → `127.0.0.1:3000`, hlavička `Host` zůstává. Skript
   ověří `/api/status` 200 a anonymní `/api/mcp` 401 a uloží certifikát CA do
   `$TMPDIR` na Macu.
2. Na Macu do `/etc/hosts` (ručně, sudo): `192.168.0.53 dawmain.davidzavada.cz`.
   Prohlížeč i `curl` na Macu teď mluví s domácím serverem pod pravým jménem;
   zbytek světa dál s Vercelem. Produkce posílá HSTS, takže prohlížeč
   self-signed certifikát bez obejití nepřijme: CA z bodu 1 dočasně přidat do
   Klíčenky (*Always Trust*), nebo jen `curl -k`.
3. Projít: přihlášení a odhlášení (bez smyčky přesměrování), `/vlastni-zdroje`
   — nahrát, potvrdit metadata, hledat, exportovat, smazat zkušební dokument
   (jde do **domácí** databáze; finální `migrate-db.sh` to přepíše);
   `/sprava` a `/sprava/system` (Server Functions); připojit a
   odpojit Zotero; `/podminky`, `/soukromi`.
4. OAuth konektoru z Macu (Claude Code: `claude mcp add --transport http`)
   — celé kolečko objevení → přihlášení → volání nástroje.
5. `deploy/web/rehearsal.sh stop` (odinstaluje Caddy i jeho CA), smazat řádek
   z `/etc/hosts` a CA z Klíčenky.

Vyzkoušeno 16. 11.: `start` → přes `curl -k --resolve` `/api/status` 200,
anonymní `/api/mcp` 401; `stop` → v CT nezůstal balíček, uživatel, soubor ani
port 443.

Co generálka neověří: webhook Clerku (chodí z internetu; má vlastní test po
přepnutí) a konektory hostované u Anthropic / OpenAI (ty ověří fáze 2 přes
bearer token a první minuty po přepnutí).

Po dobu souběhu (fáze 1–5) **neupravovat texty ve Správě**: uložení
přegeneruje statické stránky jen na tom nasazení, kde se ukládalo (a doma
se navíc přepíše finální kopií databáze).

## Fáze 5 — přepnutí (databáze i doména v jedné sekvenci)

Uživatel pozná jen pár minut, kdy nejde nahrávat (hledání a čtení běží dál).

`deploy/web/migrate-db.sh` (z Macu) zkopíruje **jen data**: schéma doma zůstává
z migrací (práva, RLS, funkce `SECURITY DEFINER`, role `dawmain_app`). Odmítne,
když se liší `schema_migrations` (název + sha256) nebo tabulky a sloupce;
pak v CT `web` `pg_dump --data-only -Fc` schématu `public` ze zdroje → přes
hostitele do CT `pg` → jako `postgres` v **jedné transakci** `TRUNCATE` všech
tabulek + data (triggery vypnuté). Při chybě zůstane domácí databáze, jak byla.
Nakonec porovná počty řádků po tabulkách a ověří, že se `dawmain_app` přihlásí,
nemá `BYPASSRLS`, bez scope nevidí nic a se scope jedné knihovny vidí právě ji.
URL zdroje bere z `SOURCE_DATABASE_URL` nebo ze stdin, nikdy z argumentů; do CT
`web` jde po stdin a žije tam jen po dobu běhu (soubor služby libpq, 600).
Bez `--replace` odmítne přepsat neprázdnou domácí databázi — **po přepnutí ho
už nikdy nespouštět**, smazal by, co uživatelé doma nahráli.

Vyzkoušeno 16. 11. proti pomocné databázi `files_src_test` v CT `pg` (migrace
0001–0006, řádky ve všech 13 tabulkách): počty i otisky obsahu (md5 řádků,
sekvence `audit_log`, generovaný sloupec `kind`) shodné; druhý běh bez
`--replace` odmítnut; zámek na tabulce doma → `lock timeout` → návrat, domácí
data beze změny; ručně změněný sloupec nebo sha migrace → odmítnuto; URL
s `-pooler` → odmítnuto. Pomocná databáze a řádek `pg_hba` pak smazány,
`files` znovu prázdná.

### Den předem

- Zkušební kopie z Neonu (`migrate-db.sh --check`, pak `--replace`) prošla,
  čas změřený; na ní se podívat, co udělá první běh cronu (níže).
- `deploy/web/preflight.sh` → GO: domácí vydání = `origin/main` = produkce,
  `FILES_DATABASE_URL` míří na `10.10.10.2`, záloha nastavená a
  `dawmain-backup.timer` zapnutý, cron vypnutý.
- `CLERK_WEBHOOK_SIGNING_SECRET` doplněný z Clerku (jinak webhook doma vrací 503).
- TTL záznamu `dawmain` je krátké (77 s, ověřeno 14. 11.); původní CNAME
  zapsaný (`dig +short CNAME dawmain.davidzavada.cz`; 14. 11.
  `79e0689ac82ac3bb.vercel-dns-017.com`, DNS only).

### Přepnutí (mimo špičku, např. večer)

1. **Vercel jen pro čtení:** v projektu `FILES_MODE=readonly` a *Redeploy*
   produkce. (Rychlejší je přepsání režimu v `system_state` (`mode_override`)
   — platí do 30 s bez nasazení, ale odcestuje s databází domů;
   `migrate-db.sh` na to upozorní a doma se po přepnutí vrátí na automatický
   režim.) Počkat, až nic nečeká na zpracování.
2. **Finální kopie:**
   ```bash
   read -rs SOURCE_DATABASE_URL && export SOURCE_DATABASE_URL   # owner Neonu, bez -pooler
   deploy/web/migrate-db.sh --replace     # počty musí sedět (počitadla se smí lišit)
   unset SOURCE_DATABASE_URL
   ```
   Když skript hlásí texty ze Správy, přebuildit (`FORCE=1 deploy.sh`, příkaz
   vypíše) — statické stránky je čtou jen při buildu.
3. **První záloha hned:** `ssh pve "pct exec 103 -- systemctl start dawmain-backup.service"`.
4. **DNS:** Cloudflare → záznam `dawmain`: z CNAME na Vercel na CNAME
   `15254ebe-679c-44bb-b460-43b938865323.cfargotunnel.com`, **Proxied**; WAF
   pravidlo *Skip* rozšířit na `http.host in {"dawmain-novy.davidzavada.cz"
   "dawmain.davidzavada.cz"}`. Než doběhnou cache DNS, část lidí ještě vidí
   Vercel — jen pro čtení, se stavem z okamžiku kopie; nikdo nedostane chybu.
5. **Cron:** zkontrolovat první běh (níže), pak
   `ssh pve "pct exec 103 -- systemctl enable --now dawmain-cron.timer"`.
   Na Vercelu nic: cron tam bez `CRON_SECRET` neběží a `CRON_SECRET` se tam
   nepřidává.
6. **Kontroly:** `deploy/web/preflight.sh --after-switch`; `dawmain_ping` →
   `region: home`; v Clerku *Webhooks → Send test* → 200 v `journalctl`;
   konektor v Claude i ChatGPT udělá rešerši bez nového přihlášení;
   přihlášení na webu; `files_list` / `files_search` přes MCP, nahrát a
   smazat dokument; `/sprava/system` (server, databáze, zrcadlo, úlohy);
   externí dohled zelený.

Ruční ekvivalenty kontrol `preflight.sh`:

```bash
git -C ~/dawmain fetch -q && git rev-parse --short origin/main
curl -s -o /dev/null -w "%{http_code}\n" https://dawmain-novy.davidzavada.cz/api/status   # 200; nástroje ověř přihlášeným konektorem
ssh pve "pct exec 103 -- sh -c \"sed 's/=.*/=…/' /etc/dawmain/env\""                    # jen názvy klíčů
ssh pve "pct exec 103 -- systemctl is-enabled dawmain-cron.timer dawmain-backup.timer"    # disabled, enabled
ssh pve "pct exec 102 -- systemctl is-active cloudflared mirror-api; lvs --noheadings -o lv_name,data_percent pve/data"
```

**Návrat** (kdykoli v prvních 14 dnech): v Cloudflare vrátit záznam `dawmain`
na původní CNAME Vercelu (DNS only), na Vercelu `FILES_MODE=on` + *Redeploy*
(příp. zrušit přepínač v Provozu), doma
`systemctl disable --now dawmain-cron.timer`. **Ztratí se všechno, co
uživatelé doma nahráli nebo změnili po přepnutí** — Neon drží stav z okamžiku
kopie. Proto: Neon i projekt na Vercelu (s doménou) nechat **14 dní
nedotčené**, pak Neon smazat a aktualizovat `/soukromi` (data už nejsou ve
Frankfurtu u Neonu, ale na vlastním serveru v ČR; Vercel a Neon vypadnou ze
seznamu zpracovatelů, Cloudflare v něm přibude).

Sledovat 7 dní: chyby v `journalctl`, odezvu, 403/429 od soudů, paměť CT,
výsledek nočních záloh.

Pojistky bezplatných tarifů (`FILES_CPU_MS_*`, hlídání 0,5 GB Neonu,
odhad hodin výpočtu z `db_activity`, „neprobouzet databázi“) platí doma dál,
včetně počitadel převzatých z Neonu — upravit v úklidu podle skutečné
kapacity disku.

### První běh cronu doma

Na Vercelu údržba nejspíš nikdy neběžela (chybí `CRON_SECRET`, endpoint vrací
503) a webhook Clerku taky ne (chybí `CLERK_WEBHOOK_SIGNING_SECRET`). První
běh doma (`app/api/cron/files/route.ts`) proto dožene všechno najednou:

| Úkol | Co první běh udělá |
| --- | --- |
| purge | Knihovny s prošlým `purge_after` (max. 5 za běh): smaže všechny jejich dokumenty (s texty, stránkami, oddíly, poznámkami, chunky), jejich počitadla a audit kromě záznamu o smazání. Bez webhooku je jich nejspíš 0. |
| owners | Až 50 knihoven za běh se ověří v Clerku. **Vlastník smazaný** → smaže hned jeho souhlas s podmínkami a počitadla čtení a volání, knihovnu smaže za 6 dní. **Vlastník bez `publicMetadata.pro === true` nebo zablokovaný** → `pro_revoked_at`; po 6 dnech označení a další den smazání. **Každá týmová knihovna `org_…`** (pozůstatek zrušených týmů) je vždy „bez Pro“ → za ~7 dní smazána. Pro vrácené dřív, než se smaže, knihovnu zachrání. |
| ingest | Dokumenty ve frontě s vyčerpanými 3 pokusy → chyba, uvolní rezervované stránky; v režimu `on` zpracuje až 3 čekající. |
| pending | Nahrávky v chybě starší 7 dní ztratí uložený text (`pending_gz`) — ruční „znovu zpracovat“ pak nejde. |
| recount | Přepočítá počitadla stránek a dokumentů knihoven (nic nemaže). |
| retention | Smaže `usage_daily` starší 365 dní, počitadla čtení `read:…` starší 1 dne, `db_activity` starší 62 dní a audit smazaných knihoven. |

Podívat se předem — na zkušební kopii po `migrate-db.sh --replace` (jen čtení,
v CT `pg` jako `postgres`: `ssh pve "pct exec 101 -- runuser -u postgres -- psql -d files"`):

```sql
-- purge hned
SELECT id, doc_count, purge_after FROM libraries WHERE purged_at IS NULL AND purge_after <= now();
-- owners: každý řádek ověřit v Clerku (účet existuje, publicMetadata.pro = true); org_… půjdou pryč
SELECT id, kind, doc_count, page_count, pro_revoked_at FROM libraries
 WHERE purged_at IS NULL AND (purge_after IS NULL OR pro_revoked_at IS NOT NULL) ORDER BY kind, id;
-- ingest: dokumenty, které skončí jako chybné
SELECT count(*) FROM documents WHERE status IN ('queued','processing') AND attempts >= 3
   AND (lease_until IS NULL OR lease_until < now());
-- pending: nahrávky, kterým se smaže uložený text
SELECT count(*) FROM documents WHERE status = 'error' AND pending_gz IS NOT NULL
   AND updated_at < now() - interval '7 days';
-- retention
SELECT count(*) FILTER (WHERE day < current_date - 365) AS starsi_nez_rok,
       count(*) FILTER (WHERE scope LIKE 'read:%' AND day < current_date - 1) AS cteni
  FROM usage_daily;
SELECT count(*) FROM db_activity WHERE minute < now() - interval '62 days';
```

Co nemá zmizet, opravit předem v Clerku (Pro u uživatele). Před prvním během
po přepnutí `ssh pve pct snapshot 101 pre-first-cron`, pak jednou ručně
`systemctl start dawmain-cron.service` a souhrn (jen počty) v
`journalctl -u dawmain-cron -n 5`; teprve potom zapnout timer. Smazání
knihoven přijde až za 6–7 dní — do té doby je čas `pro_revoked_at` /
`purge_after` zkontrolovat a Pro případně vrátit.

## Fáze 6 — úklid

- Po 14 dnech: Vercel — odebrat doménu z projektu, projekt smazat nebo nechat
  bez domény, odpojit Git integraci; Neon — smazat projekt.
- Kód: odstranit `@vercel/functions`, `vercel.json`, `neon.ts`, `@neon/*`,
  větve `process.env.VERCEL*`; `maxDuration` nechat jako dokumentaci nebo
  nahradit vlastním časovým rozpočtem (pozor: Cloudflare ukončí požadavek po
  100 s).
- Cloudflare: smazat `dawmain-novy` (DNS i ingress) a Access token
  `dawmain-vercel`; zvážit, zda `dawmain-databaze` ještě potřebuje veřejné jméno.
- Dokumentace: `docs/development.md` (nasazení, proměnné), `proxmox.md`
  (CT 103, služby, zálohy, obnova), README (věta o provozu zdarma na Vercelu).
- Nasazování: buď dál ručně `deploy.sh`, nebo GitHub Actions self-hosted
  runner v CT `web`, který po merge do `main` spustí tentýž skript.

## Rizika

| Riziko | Dopad | Opatření |
| --- | --- | --- |
| **Domácí IP vůči soudům.** Živé dotazy všech uživatelů půjdou ze stejné adresy jako crawler zrcadla; NSS ji už při backfillu blokoval (403). | Živé hledání v NSS (případně jinde) nefunguje pro všechny. | Před přepnutím nechat doběhnout backfill NSS nebo mu snížit tempo; sledovat 403/429; přepínač Živě / Zrcadlo jako záloha; krajní možnost je odchozí provoz ke zdrojům přes levný VPS. |
| Endpoint bez přihlášení po chybě v konfiguraci. | Veřejně otevřené nástroje. | 0.1 + smoke v `deploy.sh` kontroluje 401 bez tokenu. |
| Cloudflare zastaví MCP klienty jako boty. | Konektory nefungují, web ano. | Fáze 2 bod 3; ověřeno skutečným konektorem před přepnutím. |
| Výpadek proudu, internetu nebo notebooku. | Celá služba dole (na Vercelu se nestávalo). | Fáze 3 bod 5, externí dohled; Vercel jako studená záloha 14 dní po přepnutí (návrat ztratí data nahraná doma). Přijaté riziko nekomerční služby. |
| Ztráta dat uživatelů po poruše disku. | Nevratná. | Záloha mimo stroj a zkouška obnovy jsou podmínkou přepnutí (`preflight.sh`). |
| První běh cronu smaže, co nemá (údržba na Vercelu nikdy neběžela). | Ztráta knihoven uživatelů bez Pro v Clerku. | Fáze 5 „První běh cronu doma“: kontrola na zkušební kopii, snapshot, ruční první běh. |
| Zaplnění thin poolu. | Poškození dat všech CT. | Dohled `lvs`, malý disk CT `web`, rotace vydání. |
| Build vyčerpá paměť. | Nasazení selže, běžící verze zůstane. | `deploy.sh` přepíná až po úspěšném buildu a smoke. |
| Veřejná služba v domácí síti. | Po kompromitaci aplikace přístup do LAN. | Neprivilegovaný CT, zpevněný unit; do budoucna oddělit CT `web` od LAN (jen `vmbr1` + odchozí NAT). |

## Pořadí a odhad

| Fáze | Práce | Dopad na uživatele |
| --- | --- | --- |
| 0 kód | 1 večer | žádný |
| 1 kontejner | 1 večer | zrcadlo pár sekund (restart `pg`) |
| 2 tunel | 1–2 h | žádný |
| 3 provoz | 1 večer | žádný |
| 4 generálka | 1–2 h | žádný |
| 5 přepnutí | zkušební kopie předem + ~30 min okno + týden sledování | nahrávání na pár minut vypnuté |
| 6 úklid | 1 večer | žádný |
