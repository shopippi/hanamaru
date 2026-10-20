# 運用手順書

本番と検証環境の準備、公開、戻し方、バックアップ、監視の手順。作業は作成者が行う（7.3: 本番の秘密情報と本番への反映は人が扱う）。

## 全体の構成

```
利用者 ──HTTPS── Cloudflare（DNS・DDoS緩和・WAF・Access・Turnstile）
                   │
                   ├─ hanamarumusic.com ……… Cloudflare Pages（apps/top。静的）
                   └─ Tunnel ─── VPS（受信ポートはすべて閉じる）
                                 ├─ web（Caddy）: 3つのサブドメインの振り分けと画面
                                 ├─ api（Node.js）: 業務ルール・API・定期処理
                                 ├─ db（PostgreSQL）
                                 ├─ backup: 毎日 R2 へ
                                 └─ tunnel（cloudflared）
```

`infra/compose.yml` で同じ構成を、本番と検証環境の2つの VPS（または別の `.env`）で動かす（7.2）。

## 1. 最初の準備（1回だけ）

### 1.1 Cloudflare

1. **ドメインの移管**: ドメインを松田さん名義の Cloudflare アカウントへ移す（6.1）
2. **Tunnel**
   - Zero Trust → Networks → Tunnels でトンネルを作り、トークンを `infra/.env` の `CLOUDFLARE_TUNNEL_TOKEN` に入れる
   - 公開ホスト名を3つ登録し、どれも `http://web:80` に向ける
     - `student.hanamarumusic.com`
     - `staff.hanamarumusic.com`
     - `manage.hanamarumusic.com`
3. **Access（URL-02）**
   - Zero Trust → Access → Applications で `manage.hanamarumusic.com` を登録する
   - ポリシーは「Emails が松田さん・作成者のアドレス」の Allow だけにする（50人まで無料）
   - Stripe の通知は `student.hanamarumusic.com/api/stripe/webhook` で受けるため、Access の影響を受けない
4. **WAF のレート制限（NF-03）**: Security → WAF → Rate limiting rules に次の2つを足す
   - 対象のパス（ポータルごとに `/api/student`・`/api/staff`・`/api/manage` の下にある）: `/api/*/auth/login`、`/api/*/auth/password-reset`、`/api/manage/auth/mfa/verify`、`/api/student/registration`、`/api/student/trial/`、`/api/student/students/*/enrollment`
     - 式の例: `http.request.method eq "POST" and (http.request.uri.path contains "/auth/" or starts_with(http.request.uri.path, "/api/student/registration") or starts_with(http.request.uri.path, "/api/student/trial/") or ends_with(http.request.uri.path, "/enrollment"))`
     - 同じ IP から 10秒に5回を超えたら 10分ブロックする
   - 対象のパス: `/api/`
     - 同じ IP から 10秒に60回を超えたら 1分ブロックする
5. **Turnstile（NF-06）**
   - サイトを作り、サイトキーを `TURNSTILE_SITE_KEY` に、シークレットを `TURNSTILE_SECRET` に入れる
   - 本番では未設定だと API が起動しない
   - 検証環境は Cloudflare が公開しているテスト用のキーを使う
6. **Pages（URL-01、URL-03、URL-04）**: `apps/top` をそのまま公開する（ビルド不要）。`_redirects` で `/student` と `/staff` をそれぞれのログイン画面へ転送する
7. **R2（5.4）**
   - バケット `hanamaru-backups` を作る
   - ライフサイクルルールで「30日より古いオブジェクトを削除」を設定する
   - R2 の API トークン（このバケットの読み書きだけ）を作り、`R2_*` に入れる
8. **DNS**: Tunnel と Pages が作るレコードのほかは追加しない。メールの送信元の設定は 1.3

### 1.2 Stripe（6.1）

1. 松田さん名義で申し込む（審査に時間がかかるため最初に）
2. 「支払い方法」で、カード（Apple Pay・Google Pay を含む）、コンビニ、PayPay を有効にする
3. Webhook の送信先を `https://student.hanamarumusic.com/api/stripe/webhook` にし、次のイベントを選ぶ。署名シークレットは `STRIPE_WEBHOOK_SECRET` に入れる
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `invoice.paid`
   - `invoice.payment_failed`
4. `STRIPE_SECRET_KEY=... pnpm --filter @hanamaru/api exec tsx scripts/stripe-setup.ts` を実行し、出力を `STRIPE_PORTAL_CONFIGURATION_ID` に入れる（解約の操作を出さないカード管理画面: PY-13）
5. 「領収書をメールで送る」を ON にする（MB-07）
6. 検証環境はテストモードのキー（`sk_test_`）で、同じ手順を行う

### 1.3 メール（未決: 8.2）

**メール送信サービスがまだ決まっていない。** 今の API はメールを標準出力に書くだけで、実際には送らない。決まったら次の順に進める。

1. `apps/api/src/domain/notify.ts` の `EmailTransport` を、選んだサービス用に1つ実装し、`main.ts` で差し替える（NT-03 の作り）
2. サービスの案内に従い、`hanamarumusic.com` に SPF・DKIM・DMARC のレコードを足す（OP-01）。DMARC は最初は `p=none` で様子を見て、問題がなければ `p=quarantine` にする

招待・パスワード再設定・予約の通知はすべてメールなので、**公開の前に必ず必要**。

### 1.4 VPS

1. Docker と git を入れ、リポジトリを置く（GitHub のデプロイキーは読み取り専用）
2. `cp infra/env.example infra/.env` で `.env` を作り、値を埋める（`chmod 600`）
3. ファイアウォールで受信ポートをすべて閉じる。管理用の SSH も Cloudflare Tunnel 経由にするか、接続元を絞る
4. `bash infra/deploy.sh v0.1.0`
5. 最初の管理者を作る。`psql` での作業は作成者が行う（7.3）。次を1回だけ実行する

   ```sh
   docker compose -f infra/compose.yml --env-file infra/.env exec db psql -U hanamaru -d hanamaru -c \
     "insert into accounts (email, role, display_name) values ('<松田さんのメール>', 'admin', '松田')"
   ```

   その後、管理画面の「パスワードを忘れた方」から設定し、最初のログインで二段階認証を登録する

## 2. 公開と戻し方（7.2）

1. main に取り込んだら、版番号のタグを付ける

   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```

2. 検証環境の VPS で `bash infra/deploy.sh v0.1.0` を実行し、確かめる
3. 本番の VPS でも同じタグで `bash infra/deploy.sh v0.1.0` を実行する。反映の前に自動でバックアップを取る
4. 問題があれば、1つ前のタグで `deploy.sh` を実行する

**マイグレーションに注意**: データベースの変更（`apps/api/drizzle/`）は API の起動時に前へ進むだけで、戻らない。

- 変更を含む版を戻すとき、古い版が新しい列を気にしない変更（列の追加など）ならそのまま戻せる
- 列の削除・名前の変更を含む版は、反映前のバックアップ（2. の手順で取ったもの）から戻すかを判断する
- そのため、列の削除・名前の変更は、追加の版と削除の版の2回に分けて出す

## 3. バックアップと復元（5.4）

- `backup` コンテナが毎日3時に `pg_dump` を取り、R2 に送る。VPS の中にも直近7日分を残す
- R2 のライフサイクルルールで30日分を保管する
- 今すぐ取る: `docker compose -f infra/compose.yml --env-file infra/.env exec backup sh /backup.sh now`
- **四半期に1回の確認**: R2 から最新のファイルを取り出し、`bash infra/restore.sh drill <ファイル>` を実行する。使い捨てのデータベースに戻し、生徒数などを表示する（本番には触れない）。結果を記録する
- 本番に戻す: `bash infra/restore.sh apply <ファイル>`（作成者だけ）
- 設定とコードは GitHub にあるので、VPS を作り直しても 1.4 の手順で再構築できる

## 4. 監視と更新（5.2、5.3）

- **外形監視**: 無料の外形監視サービス（UptimeRobot など）で `https://student.hanamarumusic.com/api/health` を5分おきに確かめ、止まったら作成者にメールで知らせる
- **障害時**: 業務時間内に直せないときは、電話での予約受付に切り替える
- **月1回の更新**: 次の4つを確認して適用する。適用後はいつもどおり検証環境から反映する
  - OS: `apt upgrade`
  - イメージ: `deploy.sh` は `--pull` で新しいベースイメージを取る
  - 依存ライブラリ: `pnpm outdated` と GitHub の Dependabot の通知
  - Stripe の SDK

## 5. 個人情報の事故（5.5）

不正アクセスによる漏えいの疑いがあれば、次の順に対応する。

1. Cloudflare Access と Tunnel を止めて、外からの接続を断つ
2. 操作記録（管理画面の「操作記録」、`audit_logs`）と、Cloudflare のアクセスログを保全する
3. 個人情報保護委員会への報告（速報はおおむね3〜5日以内）と、本人への通知を、松田さんと進める

## 6. 公開条件（8.1）の確認表

| 条件 | 確認のしかた | 状態 |
| --- | --- | --- |
| 3章のすべての要件の受入条件が自動テストで合格 | GitHub Actions の `test`（API の受入テスト）と `e2e`（画面の通しテスト） | CI で合格 |
| 5.2 の権限テストが合格 | `apps/api/test/people.test.ts` の「5.2 権限の自動テスト」ほか | CI で合格 |
| Stripe のテストモードで、入会・毎月1日の課金・失敗・コンビニ払い・PayPay を一通り確認 | 検証環境で、Stripe のテストカード・テスト時計（Test clocks）を使って確かめる | 未 |
| iPhone の Safari と Android の Chrome で、ホーム画面アプリとして一通り操作 | 実機で、追加・ログイン・予約・キャンセル・支払い・オフライン表示を確かめる（MB-08） | 未 |
| 松田さんが検証環境で、生徒・講師・管理者の操作を一通り確認 | 受入テスト | 未 |
| プライバシーポリシー・特定商取引法の表記・利用規約を公開 | 文面を用意して公開する（8.2） | 未 |
| バックアップと復元を一度試した | 3. の `restore.sh drill` | 開発環境で確認済み。検証環境で R2 を通して要確認 |
| （追加）メール送信サービスの選定と設定 | 1.3 | 未 |
