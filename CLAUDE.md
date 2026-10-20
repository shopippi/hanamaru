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
- 状態を変える API は JSON だけを受け付ける（CSRF 対策）。Cookie はポータルごとに分ける（4.4）
- 回数は入金が確定してから付ける（PY-05）。Stripe の通知は stripe_events で重複を弾き、付与は (入金, 理由) で一意（OP-02）
- 業務ルールの中で「今」を使うときは `ctx.now()`。DB の既定値（now()）に頼る比較はしない

## 構成

- `apps/api/` API と業務ルール（Hono、Drizzle、PostgreSQL）
  - `src/db/schema.ts` テーブル定義。変えたら `pnpm --filter @hanamaru/api db:generate` でマイグレーションを作る
  - `src/domain/` 業務ルール
  - `src/http/` HTTP の入口（Hono）。ポータルごとに `/api/student`・`/api/staff`・`/api/manage`。認証と入出力の変換だけを行う
  - `src/integrations/stripe.ts` Stripe の実装。業務ルールからは `domain/payment-gateway.ts` の形だけを使い、テストでは `test/fake-gateway.ts` に差し替える
  - `src/domain/jobs.ts` 定期処理（数分おきに全部流す。どれも何度実行しても結果が同じになるように書く）
  - `src/domain/system.ts` 処理の見張りと管理者への通知（`trackedRun`）、通知の再送、古い記録の片付け、システムの状態（OP-05〜OP-08）。定期処理を足したら `JOB_LABELS` にも足す
  - `scripts/stripe-setup.ts` Stripe の初期設定（カスタマーポータル）
  - 講師プロフィールはデータベース（`teachers`・`teacher_photos`、`domain/teacher-profiles.ts`）。`data/teacher-profiles.json` は取り込み（`scripts/import-teacher-profiles.ts`）と開発用の見本だけに使う（TC-06）
  - `test/` 受入テスト（PGlite のメモリ上の PostgreSQL で動く）
- `apps/student/` 生徒の画面（ホーム画面アプリ、PWA）。`public/sw.js` が Service Worker
- `apps/staff/` 講師の画面、`apps/manage/` 管理者の画面
- `packages/ui/` 3つの画面で共通の部品・スタイル・API 呼び出し（UI-06）。UI-00〜19 の決まりはここで守る
- `e2e/` 画面の通しテスト（Playwright）
- `apps/top/` 公開トップページ（Cloudflare Pages）
- `infra/` 本番・検証環境（Docker Compose、Caddy、Cloudflare Tunnel、バックアップ、`deploy.sh`・`restore.sh`）。手順は `docs/operations.md`
- `docs/` 要件定義書、検証報告、設計の決定（ADR）

## よく使うコマンド

```sh
pnpm install
pnpm typecheck
pnpm test                                   # すべての受入テスト
pnpm --filter @hanamaru/api exec vitest run test/booking.test.ts -t RS-05
pnpm dev                                    # 開発用サーバー（メモリ上のDB・テスト決済・ダミーデータ）と3つの画面
pnpm e2e                                    # 画面の通しテスト
```

開発用サーバーのログイン: 生徒 parent@example.test（山田 はな太郎）・maruko@example.test（田中 まる子、入会手続き中） / 講師 teacher@example.test / 管理 admin@example.test（パスワードは password、管理者の確認コードは http://localhost:3000/dev/totp）。
画面は 生徒 http://localhost:5173 ・講師 :5174 ・管理 :5175。
