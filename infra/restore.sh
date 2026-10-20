#!/usr/bin/env bash
# バックアップの復元（5.4）。四半期に1回、使い捨てのデータベースに戻して確かめる。
#   bash infra/restore.sh drill  /path/to/hanamaru-YYYYMMDD-HHMMSS.sql.gz   # 確認だけ（本番に触れない）
#   bash infra/restore.sh apply  /path/to/....sql.gz                        # 本番に戻す（作成者だけ。7.3）
set -euo pipefail

MODE="${1:?usage: restore.sh drill|apply <file>}"
FILE="${2:?usage: restore.sh drill|apply <file>}"
cd "$(dirname "$0")/.."

if [ "$MODE" = "drill" ]; then
  name="hanamaru-restore-drill-$$"
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=hanamaru postgres:17.6-alpine >/dev/null
  trap 'docker stop "$name" >/dev/null' EXIT
  until docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  sleep 2
  gunzip -c "$FILE" | docker exec -i "$name" psql -q -v ON_ERROR_STOP=1 -U postgres -d hanamaru >/dev/null
  docker exec "$name" psql -U postgres -d hanamaru -c \
    "select (select count(*) from students) as students, (select count(*) from reservations) as reservations, (select count(*) from payments) as payments, (select max(created_at) from credit_ledger) as last_ledger;"
  echo "drill ok: $FILE"
elif [ "$MODE" = "apply" ]; then
  read -r -p "本番のデータベースを $FILE の内容で置き換えます。よろしいですか [yes/N] " ok
  [ "$ok" = "yes" ] || exit 1
  docker compose -f infra/compose.yml --env-file infra/.env stop api
  docker compose -f infra/compose.yml --env-file infra/.env exec -T db sh -c 'dropdb -U hanamaru hanamaru && createdb -U hanamaru hanamaru'
  gunzip -c "$FILE" | docker compose -f infra/compose.yml --env-file infra/.env exec -T db psql -q -v ON_ERROR_STOP=1 -U hanamaru -d hanamaru
  docker compose -f infra/compose.yml --env-file infra/.env start api
  echo "restored: $FILE"
else
  echo "unknown mode: $MODE" >&2
  exit 1
fi
