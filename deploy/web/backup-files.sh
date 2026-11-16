#!/usr/bin/env bash
# Nightly backup of the Vlastní zdroje database to a restic repository OFF this
# machine (Cloudflare R2, or a disk on another computer). Needed from phase 6,
# when the data moves from Neon home; set up and test the restore beforehand.
#
# Needs: postgresql-client-17, restic, and in /etc/dawmain/backup.env (600):
#   BACKUP_DATABASE_URL   owner or read-only role of the `files` database
#   RESTIC_REPOSITORY     e.g. s3:https://<account>.r2.cloudflarestorage.com/dawmain-backup
#   RESTIC_PASSWORD_FILE  /etc/dawmain/restic-password (600) — keep a copy elsewhere:
#                         without it the backups cannot be read
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   for an S3/R2 repository
#   HEALTHCHECK_URL       (optional) Healthchecks.io ping URL; silence = alarm
#
# Restore (try it once a year, into a scratch database):
#   restic dump latest files.dump > /tmp/files.dump
#   createdb files_restore && pg_restore --no-owner --no-acl -d files_restore /tmp/files.dump
set -euo pipefail

ENV_FILE=/etc/dawmain/backup.env
[ -r "$ENV_FILE" ] || { echo "$ENV_FILE is missing or unreadable" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

ping() { [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL}$1" || true; }
trap 'ping /fail' ERR
ping /start

# pg_dump -Fc is compressed and restorable table by table. Streamed straight
# into restic: no plaintext dump is left on disk here.
pg_dump --format=custom --no-owner --no-acl --dbname="$BACKUP_DATABASE_URL" \
  | restic backup --stdin --stdin-filename files.dump --tag files

# 7 daily + 4 weekly, the rest is dropped.
restic forget --tag files --keep-daily 7 --keep-weekly 4 --prune
restic check --read-data-subset=5%

ping
