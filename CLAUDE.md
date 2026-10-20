# CLAUDE.md

音楽教室（はなまる音楽教室）の予約・回数券システム。要件の正本は `docs/requirements.md`。

## 作業のルール（要件定義書 7.2・7.3）

- 作業ごとにブランチを作り、プルリクエストを出す。main に直接書き込まない
- コード・テスト・PR では要件IDで参照する（例: `RS-05`）。受入条件はそのまま自動テストにする
- 本番の秘密情報（Stripe本番キー、本番DBのパスワード）を扱わない。テストキーとダミーデータだけを使う
- 本番DBに直接アクセスしない。移行スクリプトは書くが、実行は作成者が行う
- 新しい外部サービス・依存ライブラリの追加は作成者の承認を得てから
- 要件にない機能を足さない。迷ったら質問を残して止まる
- 秘密情報はリポジトリに入れない。`.env.example`（値なしの見本）だけを置く
- 運用ルールの数値（締切、回数、料金、期間）はコードに直接書かず設定値にする（2章の1）

## 現在の状態

フェーズ0（LibreBookingの検証）が完了し、結果は `docs/phase0-report.md`。予約の中核を LibreBooking にするか自前で作るかは作成者の判断待ち。

## 構成

- `docs/requirements.md` 要件定義書（正本）
- `docs/phase0-report.md` フェーズ0の検証結果
- `infra/librebooking/` 検証用 LibreBooking の Docker 構成（ダミーデータ専用）
- `phase0/verify.sh` フェーズ0の検証スクリプト

## よく使うコマンド

```sh
cp .env.example .env    # 値を埋める
docker compose -f infra/librebooking/compose.yml --env-file .env up -d
bash phase0/verify.sh
docker compose -f infra/librebooking/compose.yml --env-file .env down -v   # データごと消す
```

Docker Hub のレート制限に当たる環境では `.env` で `LB_IMAGE` / `MARIADB_IMAGE` に `mirror.gcr.io/...` を指定する。
