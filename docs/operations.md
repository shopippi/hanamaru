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
3. `STRIPE_SECRET_KEY=... WEBHOOK_URL=https://student.hanamarumusic.com/api/stripe/webhook pnpm --filter @hanamaru/api exec tsx scripts/stripe-setup.ts` を実行する
   - 解約の操作を出さないカード管理画面（PY-13）と、Webhook の送信先を作る。送信先には、コードが扱う通知の種類（`WEBHOOK_EVENTS`）だけを、SDK と同じ API のバージョンで登録する。ダッシュボードで手で作らない
   - 出力された値を `STRIPE_PORTAL_CONFIGURATION_ID` と `STRIPE_WEBHOOK_SECRET` に入れる
4. ダッシュボードの設定（領収書のメール、無料期間の終了のメールを OFF、再試行のあとの扱い、既定のカード管理画面で解約を OFF、明細書の表記、入金のスケジュール）は `docs/stripe-prelaunch.md` の B 章のとおりにする
5. 「領収書をメールで送る」を ON にする（MB-07）
6. 検証環境はテストモードのキー（`sk_test_`）で、同じ手順を行う

### 1.3 メール（Resend。8.2）

送信は Resend、受け取りは Cloudflare Email Routing（作成者が承認。比較は `docs/mail-options.md`）。Resend で送る仕組み（`apps/api/src/integrations/resend.ts`）は用意してあり、キーを入れたときだけ使う。キーがないあいだは、メールは送らずに記録だけし、本番・検証環境では「システムの状態」が「要確認」になる。

設定の手順:

1. Resend に登録し、「Domains」で送信用のドメイン `send.hanamarumusic.com` を追加する
2. 表示される DNS の値（SPF・DKIM・戻りメール用の MX）を Cloudflare の DNS に入れ、Resend で「Verified」になるのを待つ（OP-01）
3. `hanamarumusic.com` に DMARC を足す。最初は `p=none` で様子を見て、問題がなければ `p=quarantine` にする
4. Resend で送信だけの権限の API キーを作り、`infra/.env` の `RESEND_API_KEY`・`MAIL_FROM`・`MAIL_REPLY_TO` に入れる
5. 受け取り: Cloudflare の「Email Routing」で `info@hanamarumusic.com` を松田さんの Gmail に転送する
6. API を起動し直し、「システムの状態」に警告が出ていないこと、招待メールが届くことを確かめる

招待・パスワード再設定・予約の通知はすべてメールなので、**公開の前に必ず必要**。送れなかったメールは自動で送り直す（OP-06）。

### 1.4 VPS

1. Docker と git を入れ、リポジトリを置く（GitHub のデプロイキーは読み取り専用）
2. `cp infra/env.example infra/.env` で `.env` を作り、値を埋める（`chmod 600`）
3. ファイアウォールで受信ポートをすべて閉じる。管理用の SSH も Cloudflare Tunnel 経由にするか、接続元を絞る
4. `bash infra/deploy.sh v0.1.0`
5. 最初の管理者を作る（作成者が行う。7.3）。メール送信を設定する前でも使える

   ```sh
   docker compose -f infra/compose.yml --env-file infra/.env exec api \
     node --import tsx scripts/create-admin.ts <松田さんのメール> 松田
   ```

   表示された招待リンクを開いてパスワードを決め、最初のログインで二段階認証を登録する。同じメールで何度実行しても管理者は1人のままで、リンクだけ新しくなる（リンクを使う前に期限が切れたときなど）

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

## 2.1 講師と生徒を増やす（TC-06、TC-07、ST-01）

開発者の作業はいらない。すべて管理画面で行う。

**講師を追加するとき**

1. 管理画面の「講師」で、名前とメールを入れて登録する。講師に招待メールが届く
2. 講師の詳細に移り、「次にすること」が出る
3. プロフィール（担当の楽器・ひとこと・経歴）と写真を入れて保存する。写真は画面で正方形に切り抜かれる。講師本人も、講師の画面の「プロフィール」から直せる
4. 「空き時間へ」から、講師の空き時間をカレンダーで入れる（講師本人が入れてもよい）
5. 生徒の詳細で、担当講師にその講師を付ける。付けた生徒の画面にだけ、その講師のプロフィールと空き枠が出る

**生徒を追加するとき**

- 1人ずつ: 管理画面の「生徒」で登録する。月額コースと担当講師もその場で選べる。生徒に招待メールが届く
- まとめて: 同じ画面の CSV で登録する。6列（ログインメール、保護者名、生徒名、電話番号、生徒のメール、住所）のあとに「月額コース」「担当講師」の列を足せる（なくてもよい）。担当講師は「、」で区切る
- 生徒が自分で: 自己登録を ON にすると、生徒の画面から申し込める（管理者の承認、または招待コード）
- 兄弟: 同じメールで登録すると、1つのログインで切り替えられる（ST-04）
- 登録のあと、生徒の詳細で担当講師を付け、生徒が入会の画面で「申し込む」と支払いが始まる

**以前のデータファイルからプロフィールを取り込む（1回だけ、作成者が行う）**

v1.17 より前に `apps/api/data/teacher-profiles.json` で持っていたプロフィールと写真を、データベースに入れる。講師に `profile_slug` が付いている場合だけ照らす。プロフィールが空の講師・写真のない講師にだけ入れるので、何度実行しても同じ結果になる。

```sh
DATABASE_URL=postgres://... pnpm --filter @hanamaru/api exec tsx scripts/import-teacher-profiles.ts
```

## 3. バックアップと復元（5.4）

- `backup` コンテナが毎日3時に `pg_dump` を取り、R2 に送る。VPS の中にも直近7日分を残す
- R2 のライフサイクルルールで30日分を保管する
- 今すぐ取る: `docker compose -f infra/compose.yml --env-file infra/.env exec backup sh /backup.sh now`
- **四半期に1回の確認**: R2 から最新のファイルを取り出し、`bash infra/restore.sh drill <ファイル>` を実行する。使い捨てのデータベースに戻し、生徒数などを表示する（本番には触れない）。結果を記録する
- 本番に戻す: `bash infra/restore.sh apply <ファイル>`（作成者だけ）
- 設定とコードは GitHub にあるので、VPS を作り直しても 1.4 の手順で再構築できる
- **成功の記録（OP-08）**: R2 に送れたときだけ、`backup` コンテナが `status` ボリュームの `backup-last-success` に日時を書く。API はそれを読み、管理画面の「システムの状態」に最後の成功を出す。36時間成功していなければ「要確認」になり、ダッシュボードにも出る

## 4. 監視と更新（5.2、5.3）

- **外形監視**: 無料の外形監視サービス（UptimeRobot など）で `https://student.hanamarumusic.com/api/health` を5分おきに確かめ、止まったら作成者にメールで知らせる。`/api/health` はデータベースにも問い合わせ、つながらなければ 503 を返すので、「サーバーは動いているが DB が止まっている」も検知できる（OP-08）。同じ確認をコンテナの健康診断（HEALTHCHECK）にも使い、`web` は API が健康になってから始まる
- **システムの状態（OP-05〜OP-08）**: 管理画面の「教室 → システムの状態」で、版、データベースの更新、定期処理、Stripe の通知、届けられなかった通知、バックアップを確かめられる。定期処理や Stripe の通知の処理が失敗したら、管理者にメールが届く（失敗が続いても24時間に1通、直ったら「復旧しました」）。松田さんから連絡があったら、まずこの画面を見てもらう
- **届けられなかった通知（OP-06）**: 自動で3回（5分後・30分後・2時間後）送り直す。それでも届かなければ「システムの状態」に残るので、メール送信サービスの状態を確かめてから「再送」する。招待・パスワード再設定のメールはリンクを記録していないため送り直せない。生徒の画面から招待をやり直す
- **エラー番号（OP-09）**: 想定外のエラーの画面には「エラー番号: 1a2b3c4d」が出る。`docker compose -f infra/compose.yml --env-file infra/.env logs api | grep 1a2b3c4d` で、そのときの記録を探せる
- **版の表示**: `deploy.sh` が `APP_VERSION`（タグとコミット）と `APP_BUILT_AT` を API に渡す。「システムの状態」で、いま動いている版を確かめられる
- **ログ（OP-10）**: すべてのコンテナのログは 10MB × 5ファイルまでで、古いものから消える。ディスクがログで埋まらない
- **古い記録の片付け（OP-07）**: 定期処理が毎回、期限切れのログイン状態・リンク、180日を過ぎた Stripe の通知の記録を消し、90日を過ぎたメールの本文を消す（送った記録は残す）。日数は管理画面の設定で変えられる
- **障害時**: 業務時間内に直せないときは、電話での予約受付に切り替える
- **月1回の更新**: 次の4つを確認して適用する。適用後はいつもどおり検証環境から反映する
  - OS: `apt upgrade`
  - イメージ: `deploy.sh` は `--pull` で新しいベースイメージを取る
  - 依存ライブラリ: Dependabot が毎週月曜にプルリクエストを出す（`.github/dependabot.yml`。npm、GitHub Actions、Docker のベースイメージ。細かい更新はまとめて1つにする）。CI が通ったものを作成者が確かめて取り込む。自動では取り込まない
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
