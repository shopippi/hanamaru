#!/usr/bin/env bash
# 版番号のタグを本番（または検証環境）に反映する（7.2）。VPS の上で作成者が実行する。
#   bash infra/deploy.sh v0.1.0
# 問題があれば1つ前のタグで同じコマンドを実行して戻す。
# 注意: データベースのマイグレーションは API の起動時に進むだけで、戻さない。
#       マイグレーションを含む版を戻すときは、先にバックアップから戻すかを判断する（docs/operations.md）
set -euo pipefail

TAG="${1:?usage: deploy.sh <tag>}"
cd "$(dirname "$0")/.."

git fetch --tags --quiet origin
git checkout --quiet "refs/tags/$TAG"
echo "deploying $TAG ($(git rev-parse --short HEAD))"

# 反映の前にバックアップを取る
if docker compose -f infra/compose.yml --env-file infra/.env ps --status running backup | grep -q backup; then
  docker compose -f infra/compose.yml --env-file infra/.env exec -T backup sh /backup.sh now
fi

export RELEASE="$TAG"
# システムの状態の画面（OP-08）に、どの版をいつ反映したかを出す
export APP_VERSION="$TAG ($(git rev-parse --short HEAD))"
export APP_BUILT_AT="$(date -Iseconds)"
docker compose -f infra/compose.yml --env-file infra/.env build --pull
docker compose -f infra/compose.yml --env-file infra/.env up -d --remove-orphans
docker compose -f infra/compose.yml --env-file infra/.env ps
echo "done: $TAG"
