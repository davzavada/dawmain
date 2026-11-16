#!/usr/bin/env bash
# Copy the Vlastní zdroje data from a source Postgres (Neon) into the home database `files`.
#
#   read -rs SOURCE_DATABASE_URL && export SOURCE_DATABASE_URL     # Neon OWNER, direct (no -pooler)
#   deploy/web/migrate-db.sh --check      # compare versions, migrations, schema and row counts; change nothing
#   deploy/web/migrate-db.sh              # copy (refuses when the home database already has rows)
#   deploy/web/migrate-db.sh --replace    # copy over the rows already at home (trial data)
#   unset SOURCE_DATABASE_URL
#
# Without SOURCE_DATABASE_URL the URL is read from stdin (a prompt on a terminal).
# Run from a checkout of the repository on the Mac (needs `ssh pve`).
#
# Data only. The home schema stays as the migrations created it (grants, RLS policies,
# SECURITY DEFINER functions, the role dawmain_app); this refuses unless both sides recorded
# the same migrations (filename + sha256) and have the same tables and columns. Then:
#   CT web: pg_dump --data-only -Fc of schema public (without schema_migrations) from the source,
#           streamed through the Proxmox host into CT pg (never written on the Mac);
#   CT pg:  as postgres, in ONE transaction: TRUNCATE every table … RESTART IDENTITY + the data
#           (triggers disabled, so FK order and the library_id trigger do not matter) — on any
#           error the home database stays as it was;
#   checks: row counts source = home per table, dawmain_app logs in, has no BYPASSRLS, sees no
#           rows without a scope and the right rows with one.
# Re-runnable: a trial run now, the final one at the switch (Vercel in FILES_MODE=readonly first,
# otherwise the counts may not match). Never after the switch: it would wipe what users uploaded
# at home since.
#
# The source URL never appears in argv, logs or output: it reaches CT web on stdin and lives
# there only as a root-only libpq service file for the duration of the run.
# docs/infra/migrace-z-vercelu.md, phase 5.
set -euo pipefail

PVE="${PVE:-pve}"
CHECK=0
REPLACE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --replace) REPLACE=1 ;;
    *) echo "usage: $0 [--check] [--replace]   (source URL in SOURCE_DATABASE_URL or on stdin)" >&2; exit 2 ;;
  esac
done

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n== %s\n' "$*"; }

SRC_URL="${SOURCE_DATABASE_URL:-}"
if [ -z "$SRC_URL" ]; then
  if [ -t 0 ]; then
    printf 'Source connection string (owner, direct; not shown): ' >&2
    IFS= read -rs SRC_URL; echo >&2
  else
    IFS= read -r SRC_URL || true
  fi
fi
case "$SRC_URL" in
  postgres://*|postgresql://*) ;;
  *) die "the source must be a postgres:// or postgresql:// URL" ;;
esac
case "$SRC_URL" in
  *-pooler.*|*-pooler:*) die "the source is a pooled (-pooler) Neon host: pg_dump needs the direct connection string" ;;
esac

W103=/root/.migrate-db                 # CT web: libpq service file (secrets), root only
W101=/var/lib/postgresql/migrate-db    # CT pg: the dump while it is restored, postgres only
# LANG=C: the Mac's locale, forwarded by ssh, makes perl (pct, pg_wrapper) warn on every call.
sshp() { LC_ALL=C LANG=C ssh -o BatchMode=yes "$PVE" "$@"; }
on() { sshp "pct exec $1 -- bash -s"; }   # script on stdin
cleanup() {
  printf 'rm -rf %s\n' "$W103" | on 103 >/dev/null 2>&1 || true
  printf 'rm -rf %s\n' "$W101" | on 101 >/dev/null 2>&1 || true
}
trap cleanup EXIT

# SQL on stdin → "a|b" rows. src = the source (CT web, service file), app = dawmain_app at home
# (CT web), home = the home database as postgres (CT pg, peer authentication: no password).
q() {
  case "$1" in
    src|app) sshp "pct exec 103 -- env PGSERVICEFILE=$W103/pg_service.conf PGSERVICE=$1 PGCONNECT_TIMEOUT=30 psql -X -q -At -v ON_ERROR_STOP=1" ;;
    home)    sshp "pct exec 101 -- runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -d files" ;;
  esac
}

log "Preparing the connection on CT web"
# The URL goes in as a quoted shell assignment on stdin (printf is a builtin: no argv);
# node turns it and the app role's URL into a libpq service file. Nothing is echoed.
QUOTED="'${SRC_URL//\'/\'\\\'\'}'"
PARSER='
const out = [];
try {
  for (const [name, value] of [["src", process.env.SRC_URL], ["app", process.env.FILES_DATABASE_URL]]) {
    if (!value) continue;
    const u = new URL(value);
    const kv = { host: u.hostname, port: u.port || "5432", dbname: decodeURIComponent(u.pathname.slice(1)),
                 user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    for (const [k, v] of u.searchParams) kv[k] = v;
    out.push(`[${name}]`);
    for (const [k, v] of Object.entries(kv)) {
      if (v === "") continue;
      if (/[\r\n]/.test(v) || !/^[a-z_]+$/.test(k)) throw new Error("bad");
      out.push(`${k}=${v}`);
    }
  }
} catch { console.error(`cannot parse a connection URL`); process.exit(1); }
process.stdout.write(out.join("\n") + "\n");
'
{
  printf 'set -euo pipefail\numask 077\nrm -rf %s && mkdir -m 700 %s\n' "$W103" "$W103"
  printf 'set -a; . /root/files-db-urls.env; set +a\n'
  printf 'SRC_URL=%s node -e %q > %s/pg_service.conf\n' "$QUOTED" "$PARSER" "$W103"
  printf 'grep -q "^\\[app\\]" %s/pg_service.conf || { echo "FILES_DATABASE_URL missing in /root/files-db-urls.env" >&2; exit 1; }\n' "$W103"
} | on 103 || die "could not prepare the connection on CT web"
unset SRC_URL QUOTED

log "Versions"
DUMP_V="$(printf 'pg_dump --version\n' | on 103 2>/dev/null | awk 'NR == 1 {print $3}')"
SRC_V="$(q src <<<'SHOW server_version_num')" || die "cannot connect to the source (the psql error is above)"
HOME_V="$(q home <<<'SHOW server_version_num')"
DUMP_MAJ="${DUMP_V%%.*}"; SRC_MAJ=$((SRC_V / 10000)); HOME_MAJ=$((HOME_V / 10000))
echo "source PostgreSQL $SRC_MAJ ($SRC_V), home $HOME_MAJ ($HOME_V), pg_dump on CT web $DUMP_V"
[ -n "$DUMP_MAJ" ] || die "pg_dump not found on CT web (apt install postgresql-client-17)"
[ "$SRC_MAJ" -le "$DUMP_MAJ" ] || die "the source runs PostgreSQL $SRC_MAJ, newer than pg_dump $DUMP_MAJ on CT web: install postgresql-client-$SRC_MAJ there (PGDG apt repository) first"
[ "$SRC_MAJ" -le "$HOME_MAJ" ] || die "the source runs PostgreSQL $SRC_MAJ, newer than the home server ($HOME_MAJ): data from a newer major version is not restored into an older one"

SRC_ROLE="$(q src <<<"SELECT current_user || '|' || (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = current_user")"
[ "${SRC_ROLE#*|}" = "true" ] || die "source role ${SRC_ROLE%|*} does not bypass row-level security: use the OWNER connection string (neondb_owner), not dawmain_app"
echo "source role ${SRC_ROLE%|*} bypasses RLS"

log "Schema: migrations, tables and columns"
MIG_SQL="SELECT filename || ' ' || sha256 FROM schema_migrations ORDER BY 1"
SRC_MIG="$(q src <<<"$MIG_SQL")" || die "the source has no schema_migrations table"
HOME_MIG="$(q home <<<"$MIG_SQL")"
if [ "$SRC_MIG" != "$HOME_MIG" ]; then
  diff <(cut -c1-40 <<<"$SRC_MIG") <(cut -c1-40 <<<"$HOME_MIG") | sed 's/^/  /' || true
  die "the migrations differ (< source, > home): bring both to the same set with scripts/db-migrate.mjs first"
fi
echo "same migrations: $(wc -l <<<"$HOME_MIG" | tr -d ' ') ($(cut -d' ' -f1 <<<"$HOME_MIG" | tail -1))"
COLS_SQL="SELECT c.table_name || '.' || c.column_name || ' ' || c.data_type || ' ' || c.is_nullable || ' ' || c.is_generated
  FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
 WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY 1"
SRC_COLS="$(q src <<<"$COLS_SQL")"
HOME_COLS="$(q home <<<"$COLS_SQL")"
if [ "$SRC_COLS" != "$HOME_COLS" ]; then
  diff <(echo "$SRC_COLS") <(echo "$HOME_COLS") | sed 's/^/  /' || true
  die "tables or columns differ (< source, > home) although the migrations match: someone changed a schema by hand"
fi
TABLES="$(q home <<<"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY 1")"
for t in $TABLES; do [[ "$t" =~ ^[a-z_][a-z0-9_]*$ ]] || die "unexpected table name"; done
echo "same tables and columns: $(wc -w <<<"$TABLES" | tr -d ' ') tables"

COUNT_SQL="SELECT format('SELECT %L || ''|'' || count(*) FROM public.%I', table_name, table_name)
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   AND table_name <> 'schema_migrations' ORDER BY table_name \\gexec"
# Counters the source keeps writing while it serves reads (FILES_MODE=readonly still counts calls):
# a difference there is reported, not fatal.
COUNTERS='^(usage_daily|db_activity|system_state)$'

log "Row counts"
SRC_BEFORE="$(q src <<<"$COUNT_SQL")"
HOME_BEFORE="$(q home <<<"$COUNT_SQL")"
join -t'|' <(sort <<<"$SRC_BEFORE") <(sort <<<"$HOME_BEFORE") | awk -F'|' 'BEGIN {printf "  %-18s %10s %10s\n", "table", "source", "home"} {printf "  %-18s %10s %10s\n", $1, $2, $3}'
HOME_ROWS="$(awk -F'|' '{s += $2} END {print s + 0}' <<<"$HOME_BEFORE")"

if [ "$CHECK" = 1 ]; then
  echo; echo "Check only: nothing was changed."
  exit 0
fi
if [ "$HOME_ROWS" -gt 0 ] && [ "$REPLACE" != 1 ]; then
  die "the home database already holds $HOME_ROWS rows. --replace overwrites them (trial data before the switch; NEVER after it)"
fi

log "Copying (pg_dump on CT web → host → CT pg)"
START=$(date +%s)
TRUNCATE="TRUNCATE $(sed 's/^/public./' <<<"$TABLES" | paste -sd, - | sed 's/,/, /g') RESTART IDENTITY"
sshp bash -s <<EOS || die "pg_dump failed; the home database is unchanged"
set -euo pipefail
pct exec 101 -- runuser -u postgres -- sh -c 'rm -rf $W101 && mkdir -m 700 $W101'
pct exec 103 -- env PGSERVICEFILE=$W103/pg_service.conf PGSERVICE=src PGCONNECT_TIMEOUT=30 \
    pg_dump --format=custom --data-only --schema=public --exclude-table=public.schema_migrations --no-owner --no-acl \
  | pct exec 101 -- runuser -u postgres -- sh -c 'cat > $W101/files.dump'
EOS

printf 'Dump: %s\n' "$(printf 'du -h %s/files.dump | cut -f1\n' "$W101" | on 101)"
on 101 <<EOS || die "restore failed and was rolled back; the home database is unchanged"
set -euo pipefail
cd $W101
runuser -u postgres -- pg_restore --list files.dump >/dev/null
runuser -u postgres -- pg_restore --data-only --disable-triggers --no-owner --no-acl -f files.sql files.dump
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d files \
  -c "SET lock_timeout = '30s'" -c "$TRUNCATE" -f files.sql >/dev/null
runuser -u postgres -- psql -X -q -d files -c 'ANALYZE' >/dev/null
rm -rf $W101
EOS
echo "copied in $(( $(date +%s) - START )) s"

log "Verifying"
SRC_AFTER="$(q src <<<"$COUNT_SQL")"
HOME_AFTER="$(q home <<<"$COUNT_SQL")"
FAIL=0
printf '  %-18s %10s %10s\n' table source home
while IFS='|' read -r t s h; do
  b="$(awk -F'|' -v t="$t" '$1 == t {print $2}' <<<"$SRC_BEFORE")"
  mark="ok"
  if [ "$s" != "$h" ] || [ "$s" != "$b" ]; then
    if [[ "$t" =~ $COUNTERS ]]; then mark="differs (counter, the source keeps counting)"; else mark="MISMATCH"; FAIL=1; fi
  fi
  printf '  %-18s %10s %10s  %s\n' "$t" "$s" "$h" "$mark"
done < <(join -t'|' <(sort <<<"$SRC_AFTER") <(sort <<<"$HOME_AFTER"))
[ "$FAIL" = 0 ] || die "row counts differ: the source changed during the copy (is Vercel in FILES_MODE=readonly?). Run again with --replace."

RLS="$(q home <<<"SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity")"
[ "$RLS" -ge 7 ] || die "only $RLS tables still force row-level security (expected 7)"
APP="$(q app <<<"SELECT current_user || '|' || rolbypassrls || '|' || (SELECT count(*) FROM documents) || '|' || (SELECT count(*) FROM libraries) FROM pg_roles WHERE rolname = current_user")" \
  || die "dawmain_app cannot log in to the home database"
[ "$APP" = "dawmain_app|false|0|0" ] || [ "$APP" = "dawmain_app|f|0|0" ] || die "dawmain_app check failed ($APP): it must not bypass RLS and must see no rows without a scope"
echo "dawmain_app logs in, no BYPASSRLS, sees 0 documents and 0 libraries without a scope; $RLS tables force RLS"
LIB="$(q home <<<"SELECT library_id || '|' || count(*) FROM documents GROUP BY library_id ORDER BY count(*) DESC, library_id LIMIT 1")"
if [ -n "$LIB" ]; then
  SEEN="$(q app <<<"BEGIN; SELECT set_config('app.library_ids', '${LIB%|*}', true) \\g /dev/null
SELECT count(*) FROM documents; COMMIT;")"
  [ "$SEEN" = "${LIB#*|}" ] || die "dawmain_app sees $SEEN documents in the scope of one library, the owner ${LIB#*|}"
  echo "with one library in scope dawmain_app sees exactly its ${LIB#*|} documents"
fi

# A mode override (system_state key mode_override) came along and applies at home too.
OVERRIDE="$(q home <<<"SELECT value->>'mode' FROM system_state WHERE key = 'mode_override'")"
if [ -n "$OVERRIDE" ]; then
  echo "NOTE: the copied operator override sets Vlastní zdroje to '$OVERRIDE' at home as well."
  echo "      Clear it after the switch (DELETE FROM system_state WHERE key = 'mode_override') unless that is what you want."
fi
# Texts edited in Správa live there too, but the public pages read them only at build.
if [ "$(q home <<<"SELECT count(*) FROM system_state WHERE key = 'site_texts'")" != 0 ]; then
  echo "NOTE: the copy carries texts edited in Správa; the static pages show them after a rebuild:"
  echo "      ssh pve \"pct exec 103 -- sudo -u dawmain bash -c 'cd /opt/dawmain-web/repo && FORCE=1 bash deploy/web/deploy.sh origin/main'\""
fi

echo
echo "Done. The home database holds the source data. Next: the switch checklist (docs/infra/migrace-z-vercelu.md, phase 5)."
