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
- Repo v `/opt/dawmain` (větev `claude/kind-cray-w0w1iz`), Node 22,
  aktualizace jen `git pull` + `npm ci`.

## Migrace

Před každou migrací snapshot `pg`:

```bash
ssh pve pct snapshot 101 pre-<migrace> --description "před <migrace>"
ssh pve pct exec 102 -- bash -c 'cd /opt/dawmain && npx tsx scripts/mirror.ts migrate --dry-run'
ssh pve pct exec 102 -- bash -c 'cd /opt/dawmain && npx tsx scripts/mirror.ts migrate'
```

Návrat: `pct rollback 101 pre-<migrace>` (zahodí vše zapsané po snapshotu).
