#!/usr/bin/env bash
# Dress rehearsal on the real name dawmain.davidzavada.cz without touching DNS.
#
#   deploy/web/rehearsal.sh start   Caddy on CT web: https://dawmain.davidzavada.cz on 192.168.0.53:443
#                                   (tls internal = its own CA) → 127.0.0.1:3000, Host kept
#   deploy/web/rehearsal.sh stop    remove Caddy, its CA and its config completely
#
# Only a Mac with "192.168.0.53 dawmain.davidzavada.cz" in /etc/hosts reaches the home server
# under the real name; everyone else still gets Vercel. Clerk's production instance accepts
# the name, so sign-in, uploads and Zotero can be tried for real (against the HOME database).
# The production site sends HSTS, so a browser that has seen it refuses the self-signed
# certificate without a way around it: trust the CA that `start` saves on the Mac ($TMPDIR), and remove
# it again after `stop`. Run from the Mac (needs `ssh pve`). docs/infra/migrace-z-vercelu.md, phase 4.
set -euo pipefail

PVE="${PVE:-pve}"
NAME=dawmain.davidzavada.cz
IP=192.168.0.53
CA_OUT="${TMPDIR:-/tmp}"; CA_OUT="${CA_OUT%/}/dawmain-rehearsal-ca.crt"
on() { LC_ALL=C LANG=C ssh -o BatchMode=yes "$PVE" "pct exec 103 -- bash -s"; }

case "${1:-}" in
start)
  on <<EOS
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# What the install adds (caddy + its libraries) is recorded, so that stop removes exactly that.
if ! command -v caddy >/dev/null; then
  dpkg-query -W -f '\${Package}\n' | sort > /root/.rehearsal-before
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends caddy >/dev/null
  dpkg-query -W -f '\${Package}\n' | sort | comm -13 /root/.rehearsal-before - > /root/.rehearsal-packages
  rm -f /root/.rehearsal-before
fi
cat > /etc/caddy/Caddyfile <<'CADDY'
# Dress rehearsal (deploy/web/rehearsal.sh) — removed by "rehearsal.sh stop".
{
	auto_https disable_redirects
	skip_install_trust
}
https://$NAME {
	bind $IP
	tls internal
	reverse_proxy 127.0.0.1:3000 {
		header_up Host {host}
	}
}
CADDY
# As caddy, not root: validating "tls internal" creates a CA in the user's home.
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1 \
  || { tail -5 /tmp/caddy-validate.log >&2; exit 1; }
rm -f /tmp/caddy-validate.log
systemctl enable -q caddy
systemctl restart caddy
for _ in \$(seq 1 20); do
  [ -s /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt ] && break
  sleep 1
done
EOS
  for _ in $(seq 1 20); do
    CODE="$(curl -sk -m 5 -o /dev/null -w '%{http_code}' --resolve "$NAME:443:$IP" "https://$NAME/api/status" || true)"
    [ "$CODE" = 200 ] && break
    sleep 1
  done
  [ "$CODE" = 200 ] || { echo "https://$NAME on $IP answers $CODE, not 200: journalctl -u caddy on CT web" >&2; exit 1; }
  MCP="$(curl -sk -m 10 -o /dev/null -w '%{http_code}' --resolve "$NAME:443:$IP" -X POST \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "https://$NAME/api/mcp")"
  [ "$MCP" = 401 ] || { echo "anonymous /api/mcp answered $MCP, expected 401" >&2; exit 1; }
  printf 'cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt\n' | on > "$CA_OUT"
  cat <<EOF
Rehearsal is up: https://$NAME on $IP (/api/status 200, anonymous /api/mcp 401).

1. Add this ONE line to /etc/hosts on the Mac (sudo), nothing else:
     $IP $NAME
2. Browser: the site sends HSTS, so trust the rehearsal CA saved in $CA_OUT
   (Keychain Access → System → import, "Always Trust"), or use curl -k.
3. Walk through phase 4 of docs/infra/migrace-z-vercelu.md, then: deploy/web/rehearsal.sh stop
EOF
  ;;
stop)
  on <<'EOS'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
systemctl disable -q --now caddy 2>/dev/null || true
PKGS="caddy $(cat /root/.rehearsal-packages 2>/dev/null || true)"
apt-get purge -y -qq $PKGS >/dev/null 2>&1 || apt-get purge -y -qq caddy >/dev/null 2>&1 || true
rm -f /root/.rehearsal-packages
rm -rf /etc/caddy /var/lib/caddy /var/log/caddy /usr/share/caddy /root/.local/share/caddy
rmdir /root/.step /root/.local/share /root/.local 2>/dev/null || true   # only when empty
id caddy >/dev/null 2>&1 && userdel caddy 2>/dev/null || true
getent group caddy >/dev/null && groupdel caddy 2>/dev/null || true
if command -v caddy >/dev/null || ss -ltn | grep -q ':443 '; then echo "Caddy is still there" >&2; exit 1; fi
EOS
  rm -f "$CA_OUT"
  cat <<EOF
Rehearsal stopped: Caddy, its CA and its config are gone from CT web.

Now remove this line from /etc/hosts on the Mac (sudo):
     $IP $NAME
and, if you trusted it, the rehearsal CA ("Caddy Local Authority") from Keychain Access.
Check: dig +short $NAME / curl -sI https://$NAME → server: Vercel.
EOF
  ;;
*)
  echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
