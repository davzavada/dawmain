# Proxmox: zrcadlo judikatury (v1)

Runbook domácího serveru podle [v1-plan.md](v1-plan.md). Hesla tady nejsou:
leží jen v `/etc/mirror/env` a `/root/.pgpass` na LXC `app` (práva 600).

## Hostitel

- Proxmox VE 9.2 na Dell Latitude 5310, `192.168.0.50`, z Macu `ssh pve`.
- `vmbr0`: LAN `192.168.0.0/24`, brána `192.168.0.1`.
- `vmbr1`: vnitřní síť `10.10.10.0/24` bez fyzického portu (hostitel
  `10.10.10.1`). Přidáno do `/etc/network/interfaces` 24. 10. 2026, záloha
  původního souboru `/etc/network/interfaces.bak-2026-10-24`, aplikováno
  `ifreload -a`.
- Úložiště kontejnerů `local-lvm` (thin pool 141 GB). Disky `pg` a `app`
  (120 + 20 GB) ho alokují skoro celý; skutečně se spotřebuje jen zapsané
  místo, ale zaplnění poolu poškodí data — sleduj `lvs` (Data%).

## Kontejnery

Oba Debian 13, neprivilegované, `nesting=1`, start po bootu, časová zóna
`Europe/Prague` (systemd timery). Postgres sám běží v UTC; časy jsou
`timestamptz`, převádí se až při zobrazení.

| CT | Jméno | RAM / vCPU / disk | LAN (`eth0`) | Vnitřní (`eth1`) |
| --- | --- | --- | --- | --- |
| 101 | `pg` | 8 GB / 4 / 120 GB | 192.168.0.51 (jen apt) | 10.10.10.2 |
| 102 | `app` | 4 GB / 4 / 20 GB | 192.168.0.52 (API) | 10.10.10.3 |
| 103 | `web` | 3 GB / 4 / 12 GB | 192.168.0.53 (web, testy) | 10.10.10.4 |

```bash
ssh pve pct exec 101 -- bash      # shell v pg
ssh pve pct exec 102 -- bash      # shell v app
```

## PostgreSQL 17 (`pg`)

- Balíček `postgresql-17` z Debianu 13, cluster `17/main`.
- `/etc/postgresql/17/main/conf.d/mirror.conf`: `listen_addresses =
  'localhost,10.10.10.2'` (z LAN nedostupný), `shared_buffers` 2 GB,
  `effective_cache_size` 6 GB, `work_mem` 32 MB, `maintenance_work_mem` 1 GB,
  `random_page_cost` 1.1, `default_toast_compression = lz4`, `jit = off`.
- `pg_hba.conf`: `host mirror mirror_owner,mirror_writer,mirror_reader
  10.10.10.3/32 scram-sha-256` — jen z `app`.
- Databáze `mirror` (UTF8, `C.UTF-8`), vlastník `mirror_owner`; rozšíření
  `pg_trgm`. `CONNECT` mají jen tři role `mirror_*`, do `public` nesmí
  zapisovat nikdo kromě vlastníka.

| Role | K čemu | Práva |
| --- | --- | --- |
| `mirror_owner` | migrace | vlastník databáze a schématu `mirror` |
| `mirror_writer` | crawler | čtení a zápis všech tabulek `mirror` |
| `mirror_reader` | API | jen čtení |

Nová hesla (např. po úniku): na hostiteli `openssl rand -hex 24`, v `pg`
`ALTER ROLE … PASSWORD '…'` a totéž přepsat v `/etc/mirror/env` a
`/root/.pgpass` na `app`.

## Aplikace (`app`)

- `/etc/mirror/env`: `MIRROR_OWNER_URL`, `MIRROR_WRITER_URL`,
  `MIRROR_READER_URL` (+ `PGHOST`, `PGPORT`, `PGDATABASE`).
- `/root/.pgpass`: tytéž tři role pro `psql -h 10.10.10.2 -U <role> -d mirror`.
- Repo v `/opt/dawmain` (větev `main`), Node 22,
  aktualizace jen `git pull` + `npm ci`.

## Migrace

Před každou migrací snapshot `pg`:

```bash
ssh pve pct snapshot 101 pre-<migrace> --description "před <migrace>"
ssh pve pct exec 102 -- bash -c 'cd /opt/dawmain && npx tsx scripts/mirror.ts migrate --dry-run'
ssh pve pct exec 102 -- bash -c 'cd /opt/dawmain && npx tsx scripts/mirror.ts migrate'
```

Návrat: `pct rollback 101 pre-<migrace>` (zahodí vše zapsané po snapshotu).

## Cloudflare Tunnel (veřejný přístup k API)

- `cloudflared` (balíček z pkg.cloudflare.com) v `app`, služba `cloudflared`,
  konfigurace `/etc/cloudflared/config.yml`, tunel `dawmain-databaze`
  (id `15254ebe-679c-44bb-b460-43b938865323`), přihlašovací soubor tunelu
  v `/etc/cloudflared/` (600).
- Ingress: jen `dawmain-databaze.davidzavada.cz` → `http://192.168.0.52:8080`
  (API); vše ostatní 404. Postgres ani Proxmox tunelem nevedou. Spojení jde
  jen ven, na routeru není otevřený žádný port.
- Ochrana: Cloudflare Access (aplikace `dawmain-databaze`, politika Service
  Auth se servisním tokenem `dawmain-vercel`) + bearer token API.
  Klient posílá `CF-Access-Client-Id`, `CF-Access-Client-Secret` a
  `Authorization: Bearer …`.
- Kontrola: `cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate`,
  `journalctl -u cloudflared`.

## Denní sync (krok 6)

- `mirror-sync.timer` → `mirror-sync.service` každou noc ve 03:30 (čas
  kontejneru Europe/Prague), zmeškaný běh dožene po startu.
- Pro každý zdroj nejdřív splatné řádky `fetch_queue` (běh `retry`), pak
  vše, co zdroj zveřejnil za posledních 7 dní (justice 14) — staženo znovu,
  takže se projeví i opravy u zdroje (běh `sync`). Každý běh je řádek
  `sync_run`; `mirror status` ukazuje poslední.
- NSS se synchronizuje až po doběhnutí backfillu (sdílí s ním limit NSS).
- Ručně: `npx tsx scripts/mirror.ts sync [--source us] [--days 7] [--no-retry]`.

### Databáze `files` (Vlastní zdroje)

Od přepnutí 16. 11. 2026 produkční databáze Vlastních souborů (dřív Neon;
přesun popisuje fáze 5 v [migrace-z-vercelu.md](migrace-z-vercelu.md),
jednorázový skript `deploy/web/migrace/migrate-db.sh`).

- Databáze `files` (UTF8, `C.UTF-8`, `CONNECT` jen pro `files_owner` a
  `dawmain_app`), vlastník `files_owner`. `pg_hba`: `host files
  files_owner,dawmain_app 10.10.10.4/32 scram-sha-256` (jen z `web`).
- `files_owner` — vlastník, **s `BYPASSRLS`** (skript `db-migrate.mjs` to
  vyžaduje), bez `CREATEROLE`: roli
  `dawmain_app` proto vytvořil ručně superuživatel (`NOLOGIN NOBYPASSRLS`),
  migrace `0002` ji jen zdědí. Heslo nastavené dodatečně
  `ALTER ROLE dawmain_app LOGIN PASSWORD …` + `GRANT CONNECT ON DATABASE
  files TO dawmain_app` (migrace `CONNECT` nedává).
- Hesla: `/root/files-db-urls.env` v CT `web` (600) — `DATABASE_URL_UNPOOLED`
  (owner, jen migrace) a `FILES_DATABASE_URL` (app). Do `/etc/dawmain/env`
  přijde jen `FILES_DATABASE_URL`.
- Migrace `0001`–`0007` aplikovány na PostgreSQL 17.11 bez chyby
  (`node scripts/db-migrate.mjs`, `nothing pending`).
- Přesun dat (jednorázově při přepnutí): `deploy/web/migrace/migrate-db.sh` (z Macu) kopíroval **jen data** —
  schéma, práva a RLS zůstávají z migrací; obnova běží v CT `pg` jako
  `postgres` (peer, bez hesla) v jedné transakci s `TRUNCATE`; dump jde z CT
  `web` přes hostitele, dočasně v `/var/lib/postgresql/migrate-db` (smaže se).
  Zkouška 16. 11. s pomocnou databází `files_src_test` (dočasný řádek
  `pg_hba`, obojí pak smazáno).

## Web a MCP (`web`, CT 103)

Dawmain (Next.js, web i `/api/mcp`), od 16. 11. 2026 jediná produkce (dřív
Vercel, viz [migrace-z-vercelu.md](migrace-z-vercelu.md)). Vytvořeno 15. 11. 2026, Debian 13,
neprivilegovaný, `nesting=1`, start po bootu, Node 22 (NodeSource),
`postgresql-client-17` pro zálohy.

- **Uživatel `dawmain`**, domovský adresář `/opt/dawmain-web`:
  `repo/` (klon přes read-only deploy klíč `dawmain-web` v repu GitHubu,
  klíč v `~/.ssh/id_ed25519`), `releases/<sha>/`, symlink `current`.
  Právo restartovat službu: `/etc/sudoers.d/dawmain-deploy`
  (`systemctl restart dawmain-web`, nic dalšího).
- **Nastavení** `/etc/dawmain/env` (`root:dawmain`, 640): proměnné ze sekce
  „Home server“ v `.env.example` a produkční klíče. Bez hesel v gitu.
- **Služba** `dawmain-web` (`/etc/systemd/system/`, z `deploy/web/`), port 3000
  na všech rozhraních CT; pevně `DAWMAIN_REQUIRE_AUTH=1`, `TRUST_FORWARDED_HOST=0`.
  `journalctl -u dawmain-web`.
- **Nasazení** (jako `dawmain`): `cd /opt/dawmain-web/repo && git fetch &&
  bash deploy/web/deploy.sh origin/main`. Build do nového adresáře, kontrola
  na portu 3100 (anonymní `/api/mcp` = 401, smoke test), pak přepnutí a restart;
  nezvedne-li se služba, vrátí předchozí vydání. Zůstane posledních pět vydání.
  Po změně unit souborů je zkopírovat do `/etc/systemd/system/` a
  `systemctl daemon-reload`.
- **Cron** `dawmain-cron.timer` (04:00, denní úklid Vlastních zdrojů). Na jeho
  denním běhu stojí lhůty v zásadách ochrany osobních údajů (výmaz knihovny
  „do týdne“, počty volání 12 měsíců). Ruční spuštění:
  `systemctl start dawmain-cron.service`, souhrn v `journalctl -u dawmain-cron`.
- **Záloha databáze** `dawmain-backup.timer` (02:30) → `backup-files.sh` (`pg_dump` →
  restic mimo stroj; nastavení `/etc/dawmain/backup.env`, heslo restic
  `/etc/dawmain/restic-password`). Nainstalovaná, zatím **vypnutá** a bez
  `backup.env`: záloha mimo stroj zatím neběží.
- **Jednorázové nástroje přesunu** (kontrola GO / NO-GO, kopie dat z Neonu) jsou
  pro záznam v `deploy/web/migrace/`; znovu se nespouštějí.
- **Zrcadlo** jde z webu přes LAN: `MIRROR_API_URL=http://192.168.0.52:8080`
  (API poslouchá jen na LAN adrese), bez Cloudflare Access.
- **Tunel**: v `/etc/cloudflared/config.yml` na `app` míří `dawmain.davidzavada.cz`
  a `dawmain-novy.davidzavada.cz` na `http://10.10.10.4:3000` (záloha
  `config.yml.bak-2026-11-16`). Obě jména bez Cloudflare Access. WAF pravidlo
  *Skip* (Super Bot Fight Mode, managed rules, Browser Integrity Check) pro
  `/api/` a `/.well-known/`, jinak Cloudflare zastaví konektory Claude a ChatGPT.
