#!/bin/sh
# データベースを毎日バックアップし、VPS とは別の場所（Cloudflare R2）に送る（5.4）。
# R2 側はバケットのライフサイクルルールで30日より古いものを消す（docs/operations.md）。
# VPS の中にも直近7日分を残す。
set -eu

backup_once() {
  name="hanamaru-$(date +%Y%m%d-%H%M%S).sql.gz"
  pg_dump --no-owner --no-privileges | gzip -9 > "/backups/$name.tmp"
  mv "/backups/$name.tmp" "/backups/$name"
  if [ -n "${R2_ENDPOINT:-}" ]; then
    curl --fail --silent --show-error \
      --aws-sigv4 "aws:amz:auto:s3" \
      --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
      -T "/backups/$name" \
      "$R2_ENDPOINT/$R2_BUCKET/$name"
    echo "uploaded $name"
    # システムの状態の画面（OP-08）に出す。VPS の外（R2）へ送れたときだけ成功とする
    mkdir -p /status && date -Iseconds > /status/backup-last-success.tmp && mv /status/backup-last-success.tmp /status/backup-last-success
  else
    echo "R2 is not configured: kept $name locally only" >&2
  fi
  find /backups -name 'hanamaru-*.sql.gz' -mtime +7 -delete
}

if [ "${1:-}" = "now" ]; then
  backup_once
  exit 0
fi

last=""
while true; do
  today=$(date +%Y%m%d)
  hour=$(date +%H)
  if [ "$today" != "$last" ] && [ "$hour" -ge "${BACKUP_HOUR:-3}" ]; then
    if backup_once; then last="$today"; else echo "backup failed" >&2; fi
  fi
  sleep 600
done
