#!/usr/bin/env bash
# GO / NO-GO before (and after) switching dawmain.davidzavada.cz from Vercel to
# the home server. Read-only: it changes nothing, prints no secret values.
#
#   deploy/web/preflight.sh                 before the switch
#   deploy/web/preflight.sh --after-switch  right after the DNS record was changed
#
# Run from a checkout of the repository on the Mac (needs `ssh pve`, curl, node).
# Exit 0 = GO, 1 = NO-GO. Every line says what it checked; WARN does not block,
# it names something to decide on. Checklist and rollback:
# docs/infra/migrace-z-vercelu.md, phase 5.
set -uo pipefail

PVE="${PVE:-pve}"
TEST_URL="${TEST_URL:-https://dawmain-novy.davidzavada.cz}"
PROD_URL="${PROD_URL:-https://dawmain.davidzavada.cz}"
AFTER=0
[ "${1:-}" = "--after-switch" ] && AFTER=1

FAILS=0
WARNS=0
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; WARNS=$((WARNS + 1)); }
head_() { printf '\n%s\n' "$*"; }
# ct <vmid> <script>: run a script in a container (script on stdin, no quoting trouble).
ct() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$PVE" "pct exec $1 -- sh -s" <<<"$2" 2>/dev/null; }

head_ "Proxmox a služby"
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$PVE" true 2>/dev/null; then
  bad "ssh $PVE nejde (VPN / síť?) — nic dalšího nejde ověřit"
  printf '\nNO-GO\n'; exit 1
fi
ok "ssh $PVE"
[ "$(ct 103 'systemctl is-active dawmain-web')" = "active" ] && ok "dawmain-web běží" || bad "dawmain-web neběží"
for unit in cloudflared mirror-api; do
  [ "$(ct 102 "systemctl is-active $unit")" = "active" ] && ok "$unit běží (CT app)" || bad "$unit neběží (CT app)"
done
POOL="$(ssh -o BatchMode=yes "$PVE" "lvs --noheadings -o data_percent pve/data" 2>/dev/null | tr -d ' ' | cut -d. -f1)"
if [ -n "$POOL" ] && [ "$POOL" -lt 80 ]; then ok "thin pool na ${POOL} %"; else bad "thin pool na ${POOL:-?} % (limit 80)"; fi

head_ "Vydání"
LIVE="$(ct 103 'cut -c9-15 /opt/dawmain-web/current/release.env | head -1')"
MAIN="$(git ls-remote origin refs/heads/main 2>/dev/null | cut -c1-7)"
if [ -n "$LIVE" ] && [ "$LIVE" = "$MAIN" ]; then ok "doma běží origin/main ($LIVE)"; else bad "doma běží '${LIVE:-?}', origin/main je '${MAIN:-?}' — spusť deploy.sh"; fi

head_ "Nastavení /etc/dawmain/env (jen přítomnost, ne hodnoty)"
SET="$(ct 103 "grep -v SENSITIVE /etc/dawmain/env | awk -F= '/^[A-Z_0-9]+=./ {print \$1}'")"
has() { grep -qx "$1" <<<"$SET"; }
for key in NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY CRON_SECRET \
           FILES_MODE FILES_DATABASE_URL FILES_OPERATOR_IDS CREDENTIALS_SECRET PUBLIC_URL; do
  has "$key" && ok "$key" || bad "$key chybí"
done
for key in CLERK_WEBHOOK_SIGNING_SECRET ESBIRKA_API_KEY AI_GATEWAY_API_KEY MCP_BEARER_TOKEN ZOTERO_OAUTH_CLIENT_KEY ZOTERO_OAUTH_CLIENT_SECRET \
           FILES_USER_HASH_SECRET MIRROR_API_URL MIRROR_API_TOKEN; do
  has "$key" && ok "$key" || warn "$key chybí (na Vercelu to bylo nastavené?)"
done
if has FILES_DATABASE_URL; then
  case "$(ct 103 "grep '^FILES_DATABASE_URL=' /etc/dawmain/env | sed 's#.*@\\([^/:]*\\).*#\\1#'")" in
    *neon.tech*) ok "FILES_DATABASE_URL míří na Neon (přesun databáze je až fáze 6)" ;;
    10.10.10.2) ok "FILES_DATABASE_URL míří na domácí databázi" ;;
    *) warn "FILES_DATABASE_URL míří jinam, než na Neon nebo 10.10.10.2" ;;
  esac
fi

head_ "Zkušební adresa $TEST_URL"
TOKEN="$(ct 103 "grep '^MCP_BEARER_TOKEN=' /etc/dawmain/env | cut -d= -f2-")"
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$BODY" "$TEST_URL/api/mcp")"
[ "$CODE" = "401" ] && ok "anonymní /api/mcp → 401" || bad "anonymní /api/mcp → $CODE (musí být 401)"
# A client that looks like a bot must not be stopped by Cloudflare (WAF Skip rule).
BOT="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -A 'python-httpx/0.27 (bot-test)' -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$BODY" "$TEST_URL/api/mcp")"
[ "$BOT" = "401" ] && ok "klient s „botím“ User-Agent projde Cloudflare (401 od aplikace)" || bad "klient s „botím“ User-Agent dostal $BOT — chybí WAF výjimka pro /api/"
if [ -n "$TOKEN" ] && [ -f scripts/smoke.mjs ]; then
  if MCP_URL="$TEST_URL/api/mcp" MCP_BEARER_TOKEN="$TOKEN" node scripts/smoke.mjs >/tmp/preflight-smoke.log 2>&1; then
    ok "smoke test přes internet ($(grep -c '✓' /tmp/preflight-smoke.log) kontrol)"
  else
    bad "smoke test selhal (/tmp/preflight-smoke.log)"
  fi
else
  warn "smoke test přeskočen (chybí MCP_BEARER_TOKEN v env nebo scripts/smoke.mjs; spusť z kořene repozitáře)"
fi

head_ "Cron a záloha"
TIMER="$(ct 103 'systemctl is-enabled dawmain-cron.timer')"
if [ "$AFTER" = 1 ]; then
  [ "$TIMER" = "enabled" ] && ok "dawmain-cron.timer zapnutý" || bad "dawmain-cron.timer není zapnutý (po přepnutí musí být; na Vercelu vypnout cron)"
else
  [ "$TIMER" != "enabled" ] && ok "dawmain-cron.timer vypnutý (do přepnutí cron dělá Vercel)" || bad "dawmain-cron.timer je zapnutý před přepnutím — poběží dva úklidy"
fi
if [ -n "$(ct 103 'ls /etc/dawmain/backup.env')" ]; then
  [ "$(ct 103 'systemctl is-enabled dawmain-backup.timer')" = "enabled" ] && ok "záloha databáze nastavená a zapnutá" || warn "záloha nastavená, ale dawmain-backup.timer není zapnutý"
else
  warn "záloha databáze není nastavená (/etc/dawmain/backup.env) — povinné nejpozději před fází 6 (přesun databáze)"
fi
warn "externí dohled (Healthchecks / UptimeRobot) ověř ručně — skript ho nevidí"

if [ "$AFTER" = 1 ]; then
  head_ "Produkční adresa $PROD_URL po přepnutí"
  SRV="$(curl -sI -m 15 "$PROD_URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="server" {print $2}')"
  [ "$SRV" = "cloudflare" ] && ok "odpovídá Cloudflare ($SRV)" || bad "server: '${SRV:-?}' — DNS ještě míří jinam (cache? počkej pár minut)"
  PCODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$BODY" "$PROD_URL/api/mcp")"
  [ "$PCODE" = "401" ] && ok "anonymní /api/mcp → 401" || bad "anonymní /api/mcp → $PCODE"
  if [ -n "$TOKEN" ]; then
    REG="$(curl -s -m 20 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "authorization: Bearer $TOKEN" \
      --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dawmain_ping","arguments":{}}}' "$PROD_URL/api/mcp" | grep -o 'region[^,]*' | head -1)"
    case "$REG" in *home*) ok "dawmain_ping: region home (odpovídá domácí server)" ;; *) bad "dawmain_ping: '${REG:-?}' — odpovídá jiné nasazení" ;; esac
  fi
else
  head_ "Produkční adresa zatím na Vercelu"
  SRV="$(curl -sI -m 15 "$PROD_URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="server" {print $2}')"
  [ "$SRV" = "Vercel" ] && ok "dawmain.davidzavada.cz je zatím na Vercelu (návrat zápisem tohoto CNAME)" || warn "server: '${SRV:-?}' — produkce už nejede přes Vercel?"
  printf '        původní záznam (zapsat před změnou): %s\n' "$(dig +short CNAME "${PROD_URL#https://}" | head -1)"
fi

printf '\n'
if [ "$FAILS" -eq 0 ]; then
  printf '\033[32mGO\033[0m (%s upozornění)\n' "$WARNS"; exit 0
fi
printf '\033[31mNO-GO\033[0m: %s chyb, %s upozornění\n' "$FAILS" "$WARNS"; exit 1
