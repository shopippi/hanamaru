# CLAUDE.md

音楽教室（はなまる音楽教室）の予約・回数券システム。要件の正本は `docs/requirements.md`。
予約の中核は自前で作る（`docs/decisions/0001-build-booking-core.md`。LibreBooking は使わない）。

## 作業のルール（要件定義書 7.2・7.3）

- 作業ごとにブランチを作り、プルリクエストを出す。main に直接書き込まない
- コード・テスト・PR では要件IDで参照する（例: `RS-05`）。受入条件はそのまま自動テストにし、テスト名に要件IDを入れる
- 本番の秘密情報（Stripe本番キー、本番DBのパスワード）を扱わない。テストキーとダミーデータだけを使う
- 本番DBに直接アクセスしない。移行スクリプトは書くが、実行は作成者が行う
- 新しい外部サービス・依存ライブラリの追加は作成者の承認を得てから（承認済みの一覧は ADR 0001）
- 要件にない機能を足さない。迷ったら質問を残して止まる
- 秘密情報はリポジトリに入れない。`.env.example`（値なしの見本）だけを置く
- 運用ルールの数値（締切、回数、料金、期間）はコードに直接書かず、`apps/api/src/domain/settings.ts` の設定値にする（2章の1）

## 設計の決まりごと

- 予約できるか・見られるかの判定は `apps/api/src/domain/` にだけ置く（2章の6）。画面やルーティングに同じ判定を書かない
  - 権限: `domain/access.ts`、予約のルール: `domain/booking.ts`、回数: `domain/credits.ts`、空き時間: `domain/availability.ts`
- 回数の増減は必ず `credit_ledger` に行を足す（OP-04）。残り回数は月ごとの合計
- 管理者の操作は `audit()` で記録する（OP-03）
- 通知は `Notifier` 経由で、処理の確定後に送る。送信手段は `Channel` を足すだけで増やせる（NT-03）
- 時刻はすべて日本時間（`lib/time.ts`）。月は 'YYYY-MM'、日付は 'YYYY-MM-DD'
- 他人の生徒・予約は「見つからない」（not_found）として扱い、存在も知らせない（5.2）
- エラーの文言は画面にそのまま出せる日本語で書く

## 構成

- `apps/api/` API と業務ルール（Hono、Drizzle、PostgreSQL）
  - `src/db/schema.ts` テーブル定義。変えたら `pnpm --filter @hanamaru/api db:generate` でマイグレーションを作る
  - `src/domain/` 業務ルール
  - `test/` 受入テスト（PGlite のメモリ上の PostgreSQL で動く）
- `docs/` 要件定義書、検証報告、設計の決定（ADR）

## よく使うコマンド

```sh
pnpm install
pnpm typecheck
pnpm test                                   # すべての受入テスト
pnpm --filter @hanamaru/api exec vitest run test/booking.test.ts -t RS-05
```
