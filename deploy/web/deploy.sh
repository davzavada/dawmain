#!/usr/bin/env bash
# Build one release of Dawmain, check it, and switch to it.
#
#   deploy/web/deploy.sh [git-ref]          default: origin/main
#
# Run as the `dawmain` user on LXC `web`. Layout:
#   /opt/dawmain-web/repo            git clone (fetch only)
#   /opt/dawmain-web/releases/<sha>  one release each: source + node_modules + .next/standalone
#   /opt/dawmain-web/current         symlink to the live release
#   /etc/dawmain/env                 settings (also needed at BUILD time: NEXT_PUBLIC_*)
#
# Nothing live changes until the new release has built and passed the checks
# below on a side port; if the restarted service does not come up healthy, the
# previous release is put back. docs/infra/migrace-z-vercelu.md, phase 1.
set -euo pipefail

BASE=/opt/dawmain-web
ENV_FILE=/etc/dawmain/env
REF="${1:-origin/main}"
CHECK_PORT=3100
LIVE_PORT=3000
KEEP=5

log() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -r "$ENV_FILE" ] || die "$ENV_FILE is missing or unreadable"
cd "$BASE/repo"

log "Fetching $REF"
git fetch --quiet origin
SHA="$(git rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:7}"
REL="$BASE/releases/$SHORT"
PREVIOUS="$(readlink -f "$BASE/current" 2>/dev/null || true)"

if [ -d "$REL" ] && [ "$(readlink -f "$BASE/current")" = "$REL" ]; then
  echo "Release $SHORT is already live."
  exit 0
fi

log "Unpacking $SHORT"
rm -rf "$REL"
mkdir -p "$REL"
git archive "$SHA" | tar -x -C "$REL"

# The release's own settings: everything from the env file, plus what
# identifies the build. NEXT_PUBLIC_* must be present here, at build.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export GIT_SHA="$SHA" NEXT_DEPLOYMENT_ID="$SHORT" NEXT_OUTPUT=standalone
export NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
# `next build` peaks above 2 GB; cap the heap so a small container swaps
# less and fails with a clear message rather than being OOM-killed.
export NODE_OPTIONS="--max-old-space-size=2048"

cd "$REL"
log "Installing dependencies"
# NODE_ENV=production would skip devDependencies, which the build needs.
NODE_ENV=development npm ci --no-audit --no-fund

log "Building"
npm run build

log "Assembling the standalone release"
cp -r public .next/standalone/public
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static
[ -f .next/standalone/skills/dawmain-reserse/SKILL.md ] \
  || die "the research manual is not in the standalone output (outputFileTracingIncludes)"

log "Checking the release on port $CHECK_PORT"
(
  cd .next/standalone
  PORT=$CHECK_PORT HOSTNAME=127.0.0.1 DAWMAIN_REQUIRE_AUTH=1 TRUST_FORWARDED_HOST=0 \
    node server.js >"$REL/check.log" 2>&1 &
  echo $! >"$REL/check.pid"
)
CHECK_PID="$(cat "$REL/check.pid")"
stop_check() { kill "$CHECK_PID" 2>/dev/null || true; wait "$CHECK_PID" 2>/dev/null || true; }
trap stop_check EXIT

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$CHECK_PORT/api/status" && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$CHECK_PORT/api/status" \
  || { tail -30 "$REL/check.log" >&2; die "the new release did not start"; }

# The endpoint must refuse an anonymous request. If this ever answers 200 the
# release would publish every tool: never switch to it.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "http://127.0.0.1:$CHECK_PORT/api/mcp")"
[ "$CODE" = "401" ] || die "anonymous /api/mcp answered $CODE, expected 401"

if [ -n "${MCP_BEARER_TOKEN:-}" ]; then
  MCP_URL="http://127.0.0.1:$CHECK_PORT/api/mcp" node scripts/smoke.mjs \
    || die "the MCP smoke test failed"
else
  echo "MCP_BEARER_TOKEN is not set: skipping the authenticated smoke test."
fi
stop_check
trap - EXIT

log "Switching to $SHORT"
ln -sfn "$REL" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"
sudo -n /bin/systemctl restart dawmain-web

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$LIVE_PORT/api/status" && return 0
    sleep 1
  done
  return 1
}
if ! healthy; then
  echo "The service did not come up on $SHORT." >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -sfn "$PREVIOUS" "$BASE/current.new"
    mv -T "$BASE/current.new" "$BASE/current"
    sudo -n /bin/systemctl restart dawmain-web
    healthy && die "rolled back to $(basename "$PREVIOUS")" || die "rollback failed too: look at journalctl -u dawmain-web"
  fi
  die "no previous release to return to"
fi

log "Cleaning old releases (keeping $KEEP)"
# shellcheck disable=SC2012
ls -1dt "$BASE"/releases/*/ | tail -n +"$((KEEP + 1))" | while read -r old; do
  [ "$(readlink -f "$old")" = "$(readlink -f "$BASE/current")" ] || rm -rf "$old"
done

log "Live: $SHORT"
