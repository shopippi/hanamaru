#!/bin/sh
# データベースを毎日バックアップし、VPS とは別の場所（Cloudflare R2）に送る（5.4）。
# R2 側はバケットのライフサイクルルールで30日より古いものを消す（docs/operations.md）。
# VPS の中にも直近7日分を残す。
set -eu
# pg_dump が途中で失敗したら、壊れたファイルを成功として送らない（パイプの途中の失敗も止める）
set -o pipefail

backup_once() {
  # 毎日の繰り返しでは `if backup_once` の中で呼ぶため set -e が効かない。各段階の失敗をここで確かめる
  name="hanamaru-$(date +%Y%m%d-%H%M%S).sql.gz"
  if ! pg_dump --no-owner --no-privileges | gzip -9 > "/backups/$name.tmp"; then
    rm -f -- "/backups/$name.tmp"
    echo "pg_dump failed: nothing uploaded" >&2
    return 1
  fi
  mv "/backups/$name.tmp" "/backups/$name" || return 1
  if [ -n "${R2_ENDPOINT:-}" ]; then
    curl --fail --silent --show-error \
      --aws-sigv4 "aws:amz:auto:s3" \
      --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
      -T "/backups/$name" \
      "$R2_ENDPOINT/$R2_BUCKET/$name" || { echo "upload failed: $name" >&2; return 1; }
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
