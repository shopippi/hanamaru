#!/usr/bin/env bash
# フェーズ0（要件定義書 7.1）の検証スクリプト。
# infra/librebooking/compose.yml をダミーデータ（LB_LOAD_SAMPLE_DATA=true）で起動した状態で実行する。
#   bash phase0/verify.sh
# 結果は「[OK] / [NG] / [INFO] 検証ID: 内容」で出力する。判定のまとめは docs/phase0-report.md。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a
LB="http://127.0.0.1:${LB_PORT:-8080}/Web/Services/index.php"
COMPOSE=(docker compose -f "$ROOT/infra/librebooking/compose.yml" --env-file "$ROOT/.env")
CURL=(curl -s --noproxy '*')

ok()   { echo "[OK]   $1: $2"; }
ng()   { echo "[NG]   $1: $2"; }
info() { echo "[INFO] $1: $2"; }
isref() { [ -n "$1" ] && [ "$1" != "null" ]; }
credits() { sql "SELECT CAST(credit_count AS SIGNED) FROM users WHERE user_id=$SID"; }
sql()  { "${COMPOSE[@]}" exec -T db mariadb -uroot -p"$LB_DB_ROOT_PASSWORD" librebooking -N -e "$1"; }

login() { # login <user> <password> → "token userId"
  "${CURL[@]}" -X POST "$LB/Authentication/Authenticate" -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jq -r '"\(.sessionToken) \(.userId)"'
}
api() { # api <token> <userId> <METHOD> <path> [json]
  local t=$1 u=$2 m=$3 p=$4
  if [ $# -ge 5 ]; then
    "${CURL[@]}" -X "$m" -H "X-Booked-SessionToken: $t" -H "X-Booked-UserId: $u" "$LB$p" -d "$5"
  else
    "${CURL[@]}" -X "$m" -H "X-Booked-SessionToken: $t" -H "X-Booked-UserId: $u" "$LB$p"
  fi
}

# 日付は日本時間で組み立てる（UI-18）
d() { TZ=Asia/Tokyo date -d "$1" +%Y-%m-%d; }
at() { echo "$(d "$1")T$2:00+0900"; }

# 起動直後は Apache の準備ができていないことがあるので待つ
for _ in $(seq 1 60); do
  [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$LB/")" = "200" ] && break
  sleep 2
done
read -r AT AU <<<"$(login admin password)"
[ "$AT" != "null" ] || { echo "admin login failed"; exit 1; }
A() { api "$AT" "$AU" "$@"; }

# --- 準備: 時間枠を日本時間の 10:00-21:00 / 60分に（UIの「レイアウト」設定に相当。APIなし）
sql "UPDATE layouts SET timezone='Asia/Tokyo'; UPDATE schedules SET weekdaystart=1;
     DELETE FROM time_blocks WHERE layout_id=1;
     INSERT INTO time_blocks (availability_code,layout_id,start_time,end_time) VALUES
       (2,1,'00:00:00','10:00:00'),
       $(for h in $(seq 10 20); do printf "(1,1,'%02d:00:00','%02d:00:00')," "$h" "$((h+1))"; done)
       (2,1,'21:00:00','00:00:00');
     UPDATE users SET timezone='Asia/Tokyo', language='ja_jp';
     DELETE FROM user_resource_permissions; DELETE FROM resources WHERE resource_id IN (1,2);"

# --- 準備: 講師2人をリソースとして作る（autoAssignPermissions=false で全員に権限を配らない）
mkres() {
  A POST /Resources/ "{\"name\":\"$1\",\"scheduleId\":1,\"autoAssignPermissions\":false,
    \"minLength\":\"0d1h0m\",\"maxLength\":\"0d1h0m\",\"maxParticipants\":$2,
    \"minNoticeAdd\":\"1d0h0m\",\"minNoticeUpdate\":\"1d0h0m\",\"minNoticeDelete\":\"1d0h0m\",
    \"maxNotice\":\"28d0h0m\",\"creditsPerSlot\":1,\"peakCreditsPerSlot\":1,
    \"requiresApproval\":false,\"allowMultiday\":false,\"bufferTime\":\"\"}" | jq -r .resourceId
}
RA=$(mkres "講師A（ピアノ）" 1)
RB=$(mkres "講師B（ギター）" 1)
RG=$(mkres "グループ（定員2）" 2)
info setup "resources A=$RA B=$RB group=$RG"

# --- V-02: 生徒ごとに担当講師だけを予約可能にする（グループ＝講師ごとの担当生徒の集まり）
GA=$(A POST /Groups/ '{"name":"担当:講師A","isDefault":false}' | jq -r .groupId)
A POST "/Groups/$GA/Permissions" "{\"permissions\":[$RA,$RG],\"viewPermissions\":[]}" >/dev/null
res=$(A POST /Users/ '{"firstName":"太郎","lastName":"生徒","emailAddress":"taro@example.test","userName":"taro","timezone":"Asia/Tokyo","language":"ja_jp","password":"Passw0rd!x","groups":['"$GA"']}')
if [ "$(echo "$res" | jq -r .userId)" = "null" ]; then
  ng V-09 "管理者でも API の POST /Users/ でユーザーを作れない: $(echo "$res" | jq -c .errors)（API のセッションが内部の権限確認に渡っていない不具合）"
fi
# 代替: 自己登録API（Accounts）で作り、グループ（担当）にはグループAPIで入れる
SID=$("${CURL[@]}" -X POST "$LB/Accounts/" -d '{"firstName":"太郎","lastName":"生徒","emailAddress":"taro@example.test","userName":"taro","timezone":"Asia/Tokyo","language":"ja_jp","password":"Passw0rd!x","acceptTermsOfService":true}' | jq -r .userId)
[ "$SID" != "null" ] && [ -n "$SID" ] || { echo "student create failed (LB_API_REGISTRATION_ALLOW_SELF=true が必要)"; exit 1; }
A POST "/Groups/$GA/Users" "{\"userIds\":[$SID]}" >/dev/null
perm=$(A GET "/Groups/$GA" | jq -c .permissions)
if [ "$perm" = "[]" ]; then
  ng V-09 "API の POST /Groups/{id}/Permissions は『更新しました』と返すが保存されない（同じ不具合）。以降は管理画面の操作に相当する DB 更新で代替"
  sql "INSERT INTO group_resource_permissions (group_id,resource_id,permission_type) VALUES ($GA,$RA,0),($GA,$RG,0)"
fi
members=$(A GET "/Groups/$GA" | jq -r '.users|length')
[ "$members" = "1" ] && ok V-09 "グループ（担当）への生徒の追加は API でできる" || ng V-09 "グループへの生徒追加が反映されない"
info setup "student taro userId=$SID group=$GA"
read -r ST SU <<<"$(login taro 'Passw0rd!x')"
S() { api "$ST" "$SU" "$@"; }

visible=$(S GET /Resources/ | jq -c '[.resources[].resourceId]')
if [ "$visible" = "[\"$RA\",\"$RG\"]" ] || [ "$visible" = "[\"$RG\",\"$RA\"]" ]; then
  ok V-02 "生徒の /Resources は担当講師の枠だけを返す $visible"
else
  ng V-02 "生徒の /Resources が担当外を含む: $visible"
fi

# 回数（クレジット）を付与する。APIに項目がないため DB を直接更新（V-05 の所見）
sql "UPDATE users SET credit_count=4 WHERE user_id=$SID"

# 予約APIは省略可能な項目も全部送らないとサーバーエラーになる（V-09 の所見）
resv() { # resv <resourceId> <start> <end> <userId> [title] [recurrenceRule-json]
  echo "{\"resourceId\":$1,\"startDateTime\":\"$2\",\"endDateTime\":\"$3\",\"title\":\"${5:-レッスン}\",\"userId\":$4,
    \"description\":\"\",\"accessories\":[],\"customAttributes\":[],\"invitees\":[],\"participants\":[],
    \"participatingGuests\":[],\"invitedGuests\":[],\"resources\":[],\"startReminder\":null,\"endReminder\":null,
    \"allowParticipation\":false,\"retryParameters\":[],\"termsAccepted\":true,\"recurrenceRule\":${6:-null}}"
}
D3=$(at "+3 days" 15:00); D3E=$(at "+3 days" 16:00)
res=$(S POST /Reservations/ "$(resv "$RA" "$D3" "$D3E" "$SID")")
REF=$(echo "$res" | jq -r .referenceNumber)
isref "$REF" && ok V-02 "担当講師Aの枠は予約できる ref=$REF" || ng V-02 "担当講師Aの予約が失敗: $res"

res=$(S POST /Reservations/ "$(resv "$RB" "$D3" "$D3E" "$SID")")
if ! isref "$(echo "$res" | jq -r .referenceNumber)"; then
  ok V-02 "担当外の講師Bの枠はAPIで拒否される: $(echo "$res" | jq -c .errors)"
else
  ng V-02 "担当外の講師Bの枠が予約できてしまった"
fi

# --- V-05: クレジットの消費と返却
c=$(credits)
[ "$c" = "3" ] && ok V-05 "予約で回数が1減る（4→$c）" || ng V-05 "予約後の回数が想定外: $c"

# --- V-04: 締切（予約・変更・キャンセルごと）と管理者の例外
T1=$(at "+0 days" 20:00); T1E=$(at "+0 days" 21:00) # 今日の枠＝締切（1日前）より後
res=$(S POST /Reservations/ "$(resv "$RA" "$T1" "$T1E" "$SID")")
! isref "$(echo "$res" | jq -r .referenceNumber)" \
  && ok V-04 "生徒は予約締切より後の枠を予約できない: $(echo "$res" | jq -c .errors)" \
  || ng V-04 "生徒が締切後の枠を予約できた"

FAR=$(at "+40 days" 15:00); FARE=$(at "+40 days" 16:00)
res=$(S POST /Reservations/ "$(resv "$RA" "$FAR" "$FARE" "$SID")")
! isref "$(echo "$res" | jq -r .referenceNumber)" \
  && ok V-04 "生徒は公開期間（28日）より先を予約できない（RS-03）" \
  || ng V-04 "生徒が公開期間より先を予約できた"

res=$(A POST /Reservations/ "$(resv "$RA" "$FAR" "$FARE" "$SID")")
FARREF=$(echo "$res" | jq -r .referenceNumber)
isref "$FARREF" && ok V-04 "管理者は公開期間より先でも生徒の代理予約ができる" || ng V-04 "管理者の代理予約が失敗: $res"
res=$(A POST /Reservations/ "$(resv "$RA" "$T1" "$T1E" "$SID")")
TREF=$(echo "$res" | jq -r .referenceNumber)
isref "$TREF" && ok V-04 "管理者は締切後の枠にも代理予約できる" || ng V-04 "管理者の締切後予約が失敗: $res"

c=$(credits)
info V-05 "管理者の代理予約でも本人の回数から引かれるか: 現在 $c（予約3件、初期4）"

res=$(S DELETE "/Reservations/$TREF")
if echo "$res" | jq -e '.errors|length>0' >/dev/null 2>&1; then
  ok V-04 "生徒はキャンセル締切後に取り消せない（RS-05は『取り消せるが回数は戻らない』なので差あり）"
else
  ng V-04 "生徒が締切後に取り消せた: $res"
fi

before=$(credits)
S DELETE "/Reservations/$REF" >/dev/null
after=$(credits)
[ -n "$after" ] && [ -n "$before" ] && [ "$after" -gt "$before" ] && ok V-05 "締切前キャンセルで回数が戻る（$before→$after）" || ng V-05 "締切前キャンセルで回数が戻らない（$before→$after）"

before=$after
A DELETE "/Reservations/$TREF" >/dev/null
after=$(credits)
info V-05 "締切後に管理者が取り消した場合も回数が戻るか: $before→$after（LibreBookingは削除時に常に返却）"

cols=$(sql "SHOW COLUMNS FROM users LIKE 'credit%'" | awk '{print $1}' | tr '\n' ' ')
info V-05 "クレジットは users の列（$cols）で1人1残高。月ごとの残高を持つ列・表はない"

# --- 定員（RS-08）
G1=$(at "+4 days" 11:00); G1E=$(at "+4 days" 12:00)
r1=$(A POST /Reservations/ "$(resv "$RG" "$G1" "$G1E" "$SID" グループ)" | jq -r .referenceNumber)
info RS-08 "LibreBookingの定員は『1予約の参加者数』の上限。グループ枠に別々の生徒が予約するには1予約に参加者として足す形になる ref=$r1"

# --- V-06: 管理者の繰り返し予約（毎週）
W1=$(at "next tuesday + 7 days" 17:00); W1E=$(at "next tuesday + 7 days" 18:00)
UNTIL="$(d "next tuesday + 63 days")T00:00:00+0900"
res=$(A POST /Reservations/ "$(resv "$RA" "$W1" "$W1E" "$SID" 毎週 "{\"type\":\"weekly\",\"interval\":1,\"monthlyType\":null,\"weekdays\":[2],\"repeatTerminationDate\":\"$UNTIL\"}")")
WREF=$(echo "$res" | jq -r .referenceNumber)
if isref "$WREF"; then
  n=$(A GET "/Reservations/?userId=$SID&resourceId=$RA&startDateTime=$(d '+1 day')&endDateTime=$(d '+70 days')" | jq '[.reservations[]|select(.title=="毎週")]|length')
  ok V-06 "管理者は毎週の繰り返し予約を作れる（$n 回分）"
else
  ng V-06 "繰り返し予約の作成に失敗: $res"
fi
c=$(credits)
info V-06 "繰り返し予約の後の回数: $c（回数不足の月への警告は標準にない）"

# --- V-03: 講師ごとの担当レッスン一覧（拡張サービスが管理者権限で取得する想定）
n=$(A GET "/Reservations/?resourceId=$RA&startDateTime=$(d '+0 day')&endDateTime=$(d '+70 days')" | jq '.reservations|length')
ok V-03 "講師（リソース）ごとの予約一覧をAPIで取れる（講師A: $n 件）"

code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST -H "X-Booked-SessionToken: $AT" -H "X-Booked-UserId: $AU" "$LB/Schedules/" -d '{}')
info V-01/V-03 "空き時間（スケジュールのレイアウト・休止枠）を書き換えるAPIはない（POST /Schedules/ → HTTP $code）"

# --- V-08: 自己登録と承認待ち
res=$("${CURL[@]}" -X POST "$LB/Accounts/" -d '{"firstName":"花子","lastName":"自己","emailAddress":"hanako@example.test","userName":"hanako","password":"Passw0rd!x","language":"ja_jp","timezone":"Asia/Tokyo","acceptTermsOfService":true}')
HID=$(echo "$res" | jq -r .userId)
st=$(sql "SELECT status_id FROM users WHERE user_id=$HID")
info V-08 "自己登録APIで作ったユーザーの状態: status_id=$st（1=有効。承認待ちにならず即予約できる状態になる）"
info V-08 "状態は 有効/承認待ち(メール認証)/無効 の3つ。『管理者の承認待ち』は registration.require.email.activation（本人のメール認証）でしか作れない"

# --- V-09: 外部からの操作に必要なAPI
info V-09 "予約: 作成/更新/削除/承認/一覧 あり。ユーザー: 作成/更新/削除/パスワード あり。権限: グループ単位のみ（ユーザー個別の権限APIなし）。クレジット: APIなし。スケジュール・休止枠: 書き込みAPIなし"

# --- V-07: 保護者と子ども
t=$(sql "SELECT GROUP_CONCAT(table_name) FROM information_schema.tables WHERE table_schema='librebooking' AND (table_name LIKE '%parent%' OR table_name LIKE '%guardian%' OR table_name LIKE '%family%' OR table_name LIKE '%delegat%')")
[ "$t" = "NULL" ] && t=""
info V-07 "保護者と子どもを結ぶ表: ${t:-なし}。1アカウント=1利用者で、他人の代わりに予約できるのは管理者だけ"

echo "done"
