#!/usr/bin/env bash
# Install the production settings from Vercel on the home server in one step.
#
#   npx vercel env pull --environment=production .env.prod     # on the Mac, once logged in
#   deploy/web/import-env.sh .env.prod --dry-run               # what would happen, no changes
#   deploy/web/import-env.sh .env.prod                         # do it
#   rm .env.prod                                               # the file holds every production secret
#
# What it does to /etc/dawmain/env on CT `web`:
#   - keeps the application's settings (Clerk, FILES_*, Zotero, CREDENTIALS_SECRET, e-Sbírka, …)
#   - drops what only made sense on Vercel (VERCEL_*, the Neon connection strings DATABASE_URL*,
#     PG*, POSTGRES_*, NEON_*, MIRROR_CF_ACCESS_* — the mirror is reached over the LAN)
#   - forces the home values: PUBLIC_URL, APP_ENV, APP_REGION, MIRROR_API_URL
#     (FILES_DATABASE_URL stays as in production: still Neon until phase 6)
#   - backs up the old file (/etc/dawmain/env.bak-<time>, root only)
#   - rebuilds the live commit (FORCE=1 deploy.sh: NEXT_PUBLIC_* are inlined at build) and, if
#     that fails, puts the old file back.
# Never prints a value, only key names. Run from a checkout of the repository on the Mac
# (needs `ssh pve`). See docs/infra/migrace-z-vercelu.md, phase 4.
set -euo pipefail

PVE="${PVE:-pve}"
INPUT="${1:-}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1
[ -n "$INPUT" ] && [ -r "$INPUT" ] || { echo "usage: $0 <env file from vercel env pull> [--dry-run]" >&2; exit 2; }

# Key NAMES that must not be carried over from Vercel (whole-name match).
DROP='^(VERCEL.*|NX_.*|TURBO_.*|DATABASE_URL.*|PG[A-Z]*|POSTGRES_.*|NEON_.*|MIRROR_CF_ACCESS_.*|PUBLIC_URL|APP_ENV|APP_REGION|MIRROR_API_URL|DAWMAIN_REQUIRE_AUTH|TRUST_FORWARDED_HOST|NEXT_OUTPUT|NEXT_DEPLOYMENT_ID|GIT_SHA)$'
REQUIRED="NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY CLERK_WEBHOOK_SIGNING_SECRET FILES_MODE FILES_DATABASE_URL FILES_OPERATOR_IDS CREDENTIALS_SECRET"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

# KEY=VALUE lines only (comments and blanks are dropped), minus the dropped keys.
ALL="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$INPUT" || true)"
awk -F= -v re="$DROP" '$1 !~ re' <<<"$ALL" > "$TMP"
KEPT="$(cut -d= -f1 "$TMP" | sort)"
DROPPED="$(cut -d= -f1 <<<"$ALL" | sort | awk -v re="$DROP" '$0 ~ re')"

# Carry over the CRON_SECRET already on the server when production has none.
if ! grep -q '^CRON_SECRET=' "$TMP"; then
  EXISTING="$(ssh -o BatchMode=yes "$PVE" "pct exec 103 -- sh -s" <<<"grep '^CRON_SECRET=' /etc/dawmain/env" 2>/dev/null || true)"
  [ -n "$EXISTING" ] && { echo "$EXISTING" >> "$TMP"; echo "CRON_SECRET: production has none, the one on the server stays."; }
fi

# The home values, always last so they win.
cat >> "$TMP" <<'EOF'
PUBLIC_URL=https://dawmain.davidzavada.cz
APP_ENV=production
APP_REGION=home
MIRROR_API_URL=http://192.168.0.52:8080
EOF

echo "Kept from the file ($(wc -l <<<"$KEPT" | tr -d ' ')):";  sed 's/^/  /' <<<"$KEPT"
echo "Dropped (Vercel / Neon / home overrides):";              sed 's/^/  /' <<<"${DROPPED:-(none)}"
echo "Forced for the home server: PUBLIC_URL APP_ENV APP_REGION MIRROR_API_URL"
MISSING=""
for key in $REQUIRED; do grep -q "^$key=" "$TMP" || MISSING="$MISSING $key"; done
if [ -n "$MISSING" ]; then
  echo "MISSING required keys:$MISSING" >&2
  echo "(Vercel hides 'sensitive' variables from env pull — add those by hand to $INPUT first.)" >&2
  [ "$DRY" = 1 ] || { echo "Nothing was changed." >&2; exit 1; }
fi
[ "$DRY" = 1 ] && { echo "Dry run: nothing was changed."; exit 0; }

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "Installing /etc/dawmain/env (backup: env.bak-$STAMP) …"
ssh -o BatchMode=yes "$PVE" "pct exec 103 -- sh -c 'umask 077; cat > /etc/dawmain/env.new'" < "$TMP"
ssh -o BatchMode=yes "$PVE" "pct exec 103 -- sh -s" <<EOF
set -e
cp -a /etc/dawmain/env /etc/dawmain/env.bak-$STAMP
chmod 600 /etc/dawmain/env.bak-$STAMP
chown root:dawmain /etc/dawmain/env.new
chmod 640 /etc/dawmain/env.new
mv /etc/dawmain/env.new /etc/dawmain/env
EOF

echo "Rebuilding the live commit with the new settings (a few minutes) …"
current() { ssh -o BatchMode=yes "$PVE" "pct exec 103 -- sh -s" <<<"readlink /opt/dawmain-web/current"; }
BEFORE_REL="$(current)"
LOG="$(mktemp)"
# `git pull`, not fetch: deploy.sh itself comes from the working tree of the server's clone.
if ssh -o BatchMode=yes "$PVE" "pct exec 103 -- sudo -u dawmain bash -c 'cd /opt/dawmain-web/repo && git checkout -q main && git pull -q origin main && FORCE=1 bash deploy/web/deploy.sh origin/main'" >"$LOG" 2>&1; then
  DEPLOY_OK=1
else
  DEPLOY_OK=0
fi
grep -E '^== |ERROR|passed|Live|Removed|rolled|already' "$LOG" || true
rm -f "$LOG"
AFTER_REL="$(current)"
# A deploy that exits 0 without switching (an old deploy.sh that says "already live") did NOT
# rebuild: the running service has not seen the new settings.
if [ "$DEPLOY_OK" = 1 ] && [ "$AFTER_REL" = "$BEFORE_REL" ]; then
  echo "deploy.sh finished but did not build a new release." >&2
  DEPLOY_OK=0
fi

if [ "$DEPLOY_OK" = 1 ]; then
  echo "Done: $(basename "$BEFORE_REL") → $(basename "$AFTER_REL"). Next: deploy/web/preflight.sh"
else
  echo "Failed — putting the old settings back (the service still runs $(basename "$AFTER_REL"))." >&2
  ssh -o BatchMode=yes "$PVE" "pct exec 103 -- sh -s" <<RESTORE
cp -a /etc/dawmain/env.bak-$STAMP /etc/dawmain/env && chown root:dawmain /etc/dawmain/env && chmod 640 /etc/dawmain/env
RESTORE
  exit 1
fi
