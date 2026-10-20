#!/bin/bash
# LibreBooking のデータベースを初回だけ作る。
# database_schema/setup-database.sh と同じ順序（schema → upgrades → data）を非対話で行う。
set -euo pipefail

mysql() { mariadb -h db -u root -p"${MARIADB_ROOT_PASSWORD}" "$@"; }

if mysql -N -e "SELECT 1 FROM information_schema.tables WHERE table_schema='librebooking' AND table_name='users'" | grep -q 1; then
  echo "librebooking database already initialized"
  exit 0
fi

mysql -e "CREATE DATABASE IF NOT EXISTS librebooking CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql librebooking < /schema/create-schema.sql
for v in $(find /schema/upgrades -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V); do
  for f in schema.sql data.sql; do
    if [ -f "/schema/upgrades/${v}/${f}" ]; then
      echo "applying upgrades/${v}/${f}"
      mysql librebooking < "/schema/upgrades/${v}/${f}"
    fi
  done
done
mysql librebooking < /schema/create-data.sql
if [ "${LB_LOAD_SAMPLE_DATA:-false}" = "true" ]; then
  # 検証用のダミーデータ（admin / user）。本番では読み込まない
  mysql librebooking < /schema/sample-data-utf8.sql
fi

mysql -e "CREATE USER IF NOT EXISTS 'lb_user'@'%' IDENTIFIED BY '${LB_DATABASE_PASSWORD}'; GRANT ALL ON librebooking.* TO 'lb_user'@'%'; FLUSH PRIVILEGES;"
echo "librebooking database initialized"
