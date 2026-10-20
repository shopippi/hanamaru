# メールの送受信をお金をかけずに始める方法（hanamarumusic.com）

調べた日: 2026年10月20日。料金や上限は変わることがあるので、契約の前に各社の公式ページで確かめる。確かめきれなかったことは「未確認」と書く。

## 結論

- **受信は0円でできる。**
  - Cloudflare の Email Routing で `info@hanamarumusic.com` 宛のメールを、松田さんの Gmail に転送する。
- **システム（アプリ）からの送信も0円で始められる。**
  - Resend の無料プランを使う。月3,000通、1日100通まで。独自ドメインでの署名（DKIM）にも対応している。
  - 想定は月500〜700通なので収まる。
  - ただし1日100通の上限があるので、生徒が80〜100人を超えて月初に通知が集中したら、有料（月20ドル）に上げる。
- **「Gmail から info@ として返信する」は、無料のままでは長く続けられない。**
  - 無料の Gmail で他社のアドレスとして送る機能（他のアドレスからメールを送信）は、2027年1月で終わる。
  - その後も Gmail の画面から info@ で送りたいなら、Google Workspace（有料、1人あたり月800円前後）が必要になる。
- **「いずれ Google にエイリアスとして追加」は、今の DNS の組み方でそのまま移れる。**
  - 移るときは、受信の向き先（MX）を Cloudflare から Google に替えるだけでよい。
  - システムの送信（Resend）はそのまま使い続けられる。

## 1. 受信と、Gmail で読む・返す

### 1-1. 受信: Cloudflare Email Routing（無料）
- `info@` などの宛先ごとに、転送先（松田さんの Gmail）を決める。転送先は確認メールで認証したアドレスだけ。
- **上限:**
  - 1つのメールは25MBまで
  - 転送のルールは1ドメインに200個まで
  - 転送先は1アカウントに200個まで［S1］
- **DNS:** Cloudflare が次のレコードを足す［S2］。
  - MX: `route1/2/3.mx.cloudflare.net`
  - SPF: `v=spf1 include:_spf.mx.cloudflare.net ~all`
  - DKIM: `cf2024-1._domainkey`
- **ほかのメールサーバーとは同時に使えない。** 受信できるのは1か所だけ（MX は1組）。
  - Google Workspace に移るときは、MX を Google のものに替え、Email Routing を止める［S2］。

### 1-2. Gmail から info@ として送る（返信など）
- **無料の Gmail の「他のアドレスからメールを送信」:**
  - 送るには、そのアドレスの側の SMTP サーバーが要る［S3］。Cloudflare Email Routing は受信専用で、SMTP は持たない。
  - そのため、送信サービス（例: Resend の SMTP）を SMTP として登録して使うことになる。
- **2027年1月から、無料の Gmail は他社のアドレスとして送る機能（Send as）に対応しなくなる**［S3］［S4］。
  - Gmail の別名や、Google Workspace のアドレスは対象外。
  - つまり、無料のまま Gmail から info@ で送る方法は、2027年1月までのつなぎにしかならない。
- **Gmail の SMTP（smtp.gmail.com）で info@ として送る方法は勧めない。**
  - 独自ドメインの DKIM で署名できないため、DMARC の判定で不利になる。携帯キャリアや Gmail で迷惑メール扱いされやすい。
  - 1日500通までで、超えると最大24時間止まる［S11］。システムの送信には使わない。

### 1-3. 「Google にエイリアスとして追加」の意味
- **(a) 無料 Gmail の Send as:** 上のとおり 2027年1月で終わる。
- **(b) Google Workspace:**
  - `hanamarumusic.com` を Workspace のドメインにして、`info@` や `matsuda@` を本物のアドレスか別名（エイリアス）として持つ。
  - Gmail の画面で受信も送信もできる。DKIM も Google が署名する。
  - **料金:** Business Starter で1人あたり月800円前後（年契約・税別。資料によって800〜907円）［S5］。公式の日本語料金ページで最終確認する（未確認）。
  - **別名の扱い:** 1人の契約で、別名（`info@`、`lesson@` など）を何個か持てる。別名には料金はかからない。

## 2. システムからの送信（招待、再設定、予約の通知、お支払いの連絡など）

### 2-1. 送る量の見込み
- 50人の場合: 予約の確定4通、前日のリマインド4通、お支払い1〜2通で、1人あたり月9〜10通。合計で月500〜700通程度。
- **集中する日:** 月初の1日（コンビニ・PayPay の支払いリンク、自動払いの失敗のお知らせ）と、予約の多い日の前日（リマインド）。

### 2-2. 比較

| サービス | 無料の範囲 | 独自ドメイン | 送り方 | 日本の携帯キャリア向け | 注意 |
| --- | --- | --- | --- | --- | --- |
| **Resend** | 月3,000通・1日100通［S6］ | 3ドメイン。DKIM・SPF・DMARC に対応 | API と SMTP | 署名がそろうので不利になりにくい（キャリアごとの公式の基準は未確認） | ログは30日。1日100通を超えると、その日は送れない |
| Brevo | 1日300通（第三者の資料。公式で未確認）［S7］ | DKIM に対応 | API と SMTP | 同上 | 無料だとメールに Brevo のロゴが入る |
| Mailgun | 1日100通［S8］ | 1ドメイン | API と SMTP | 同上 | ログは1日しか残らない |
| SMTP2GO | 月1,000通［S9］ | DKIM・SPF を自動で設定 | API と SMTP | 同上 | 有料は月10ドルで月1万通 |
| MailerSend | 月500通・1日100回［S10］ | 1ドメイン | API と SMTP | 同上 | 審査とカードの登録が必要。500通では足りない月がある |
| Postmark | 月100通（期限なし）［S12］ | 10ドメイン | API と SMTP | 届きやすさに定評 | 無料は試す程度。有料は月15ドルで月1万通 |
| Amazon SES | 1,000通あたり0.10ドル。新規は最初の6か月だけ無料枠のクレジット［S13］ | DKIM に対応 | API と SMTP | 同上 | 本番で使うには利用申請が要る。設定が多い |
| SendGrid | 無料プランは2025年に終了。60日の試用だけ［S14］ | － | － | － | 継続は月19.95ドルから |
| Cloudflare Email Sending | 外部への送信は Workers Paid（月5ドル）が必要［S15］ | 対応 | API・Workers・SMTP | － | まだベータ版 |
| Gmail の SMTP | 1日500通 | DKIM で独自ドメインの署名ができない | SMTP | 迷惑メールになりやすい | 規約上の止められる危険があり、システムの送信には向かない |

### 2-3. 選ぶなら Resend
- 無料の範囲（月3,000通）で、今の見込みに収まる。
- 独自ドメインの署名ができるので、DMARC を通せる。
- **API で送れるので、つなぐのが簡単。**
  - 実装は `apps/api/src/domain/notify.ts` の Channel（`deliver(address, message)`）を1つ足すだけ（NT-03）。
  - 新しい依存ライブラリは要らず、HTTPS の呼び出しで送れる。
- **1日100通の上限に当たったら送れない。**
  - 今の作りでは、その通知は「送れなかった」として残る。
  - 月初に100通を超えそうになったら、有料のプラン（月20ドルで月5万通。料金は未確認）に上げる。
- **日本の携帯キャリア（docomo・au・SoftBank）の注意**［S16］
  - キャリアのメールは、届かなくてもエラーが返らないことがある。
  - 生徒には、入会時に `@hanamarumusic.com` からのメールを受け取れるよう、受信許可（ドメイン指定受信）の設定をお願いする案内を出すのが安全。

## 3. DNS の設定（Cloudflare 上）

| 種類 | 名前 | 値（例） | 何のため | Workspace に移るとき |
| --- | --- | --- | --- | --- |
| MX | `@` | `route1/2/3.mx.cloudflare.net` | 受信（Email Routing） | Google の MX（`smtp.google.com`）に替える |
| TXT | `@` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | 受信側の SPF | `v=spf1 include:_spf.google.com ~all` に替える（SPF は1つのレコードにまとめる） |
| TXT | `cf2024-1._domainkey` | Cloudflare が出す値 | Email Routing の DKIM | 消してよい |
| TXT | `resend._domainkey` | Resend の画面に出る値 | システムの送信の DKIM | そのまま |
| MX | `send` | Resend の画面に出る値（戻りメールの受け口） | システムの送信の戻りメール | そのまま |
| TXT | `send` | Resend の画面に出る SPF | システムの送信の SPF（サブドメイン側に置くので、本体の SPF とぶつからない） | そのまま |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:info@hanamarumusic.com` | DMARC。最初は様子見（none） | 問題がなければ `p=quarantine` にする |
| TXT | `google._domainkey` | Google が出す値 | Workspace の DKIM | Workspace に移るときに足す |

- Resend のレコード名（`resend._domainkey`、`send`）は、今の Resend の案内に合わせた例。実際は Resend の画面に出るものを入れる（未確認）。
- DKIM は送るサービスごとにセレクター（`resend`、`google` など）が別なので、ぶつからない。
- SPF は、ドメイン本体（`@`）に1つだけ置く。

## 4. 進める順番

1. ドメインを Cloudflare に移す（運用の手順 1.1）。
2. Email Routing で `info@` を松田さんの Gmail に転送する（0円）。
3. Resend の無料アカウントを作り、`hanamarumusic.com` を登録して、DKIM・SPF のレコードを Cloudflare に入れる（0円）。
4. API キーを本番のサーバーの環境変数に入れる。システム側で Resend 用の Channel を実装し、テストで確かめる（新しい外部サービスなので、作成者の承認が要る）。
5. `_dmarc` を `p=none` で入れ、レポートを見て問題がなければ `p=quarantine` にする。
6. （2027年1月まで）Gmail の「他のアドレスからメールを送信」に、Resend の SMTP を登録して `info@` として返信する。
7. （お金をかけてよくなったら）Google Workspace に移る。MX と SPF を Google のものに替え、Email Routing を止める。Resend はそのまま使う。

**お金が必要になるのは、次のどちらかになったとき:**
- 月初などに1日100通を超えるようになった → Resend の有料プラン
- 2027年1月以降も Gmail の画面から info@ で送りたい → Google Workspace

## 出典（確認日はすべて 2026年10月20日）

- S1. Cloudflare「Email Routing limits」 https://developers.cloudflare.com/email-routing/limits/
- S2. Cloudflare「Email Routing DNS records」 https://developers.cloudflare.com/email-routing/setup/email-routing-dns-records/
- S3. Google Gmail ヘルプ「Send emails from a different address or alias」 https://support.google.com/mail/answer/22370
- S4. Proton・Android Authority の報道（Send as の終了） https://proton.me/blog/gmail-ends-send-as-third-party ／ https://androidauthority.com/gmail-killing-third-party-send-as-feature-3694659
- S5. Google Workspace の料金の解説（第三者の資料。公式で未確認） https://atsoho.com/apps/p/google-workspace ／ https://saas.imitsu.jp/cate-groupware/service/813/price
- S6. Resend「Pricing」 https://resend.com/pricing
- S7. Brevo の料金の解説（第三者の資料。公式のページでは数値を確認できず） https://dreamlit.ai/blog/brevo-review
- S8. Mailgun「Pricing」 https://www.mailgun.com/pricing/
- S9. SMTP2GO「Pricing」 https://www.smtp2go.com/pricing/
- S10. MailerSend「Pricing」 https://www.mailersend.com/pricing
- S11. Gmail の送信上限の解説 https://developer.nylas.com/docs/cookbook/email/gmail-smtp-settings.md
- S12. Postmark「Pricing」 https://postmarkapp.com/pricing
- S13. Amazon SES「Pricing」 https://aws.amazon.com/ses/pricing/
- S14. Twilio「Changes coming to SendGrid's free plans」 https://www.twilio.com/en-us/changelog/changes-coming-to-sendgrid-s-free-plans
- S15. Cloudflare「Email Service」 https://developers.cloudflare.com/email-service/
- S16. キャリアメールが届かない件の解説（第三者の資料） https://blastmail.jp/pdf/knowhow3.pdf
