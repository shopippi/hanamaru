# カード決済を始める前に必要なこと（Stripe・法令）

カードの登録と決済を本番で始める前に、教室側で用意すること、Stripe で設定すること、法令で求められること、いまの実装との照合、テストモードでの確かめ方をまとめる。調べた日は 2026年10月20日。各項目の末尾の［］は出典（F 章の番号）。確認できなかったことは「未確認」と書く。

税務・法務の最終判断は、税理士・専門家に確かめる（Stripe 自身も、特商法などの法令に沿っていることを保証しないと書いている［F2］）。

---

## A. 事前に用意するもの（教室側）

### A-1. Stripe のアカウントを有効にするための情報
- **事業の情報**
  - 名称（法人なら登記名と法人番号13桁）、所在地、業種、事業の説明（何を、誰に、いくらで売るか）、ウェブサイトの URL［F3］
  - 個人事業主は、屋号ではなく個人名で登録する［F4］
- **代表者の情報**
  - 氏名、生年月日、住所、電話番号［F3］
  - 本人確認書類は、パスポート、運転免許証、マイナンバーカード、在留カード、住民票などのいずれか［F3］
- **入金先の銀行口座**
  - 国内の口座。口座名義はカタカナかローマ字で書く［F4］
  - 個人事業主は、代表者本人の名義にする。名義が違うと入金が止まることがある［F4］
- **審査にかかる日数:** ふつうは2〜3営業日。追加の書類を求められると1〜2週間かかる［F3］

### A-2. 公開ウェブサイトに載せるもの（いまの `apps/top` には足りない）
いまの公開トップページは、教室名とログインのボタンだけである。審査では、何を売っているか（商品）の情報や特商法の表記が足りないことがよくある却下理由になっている［F3］。

次のものを、ログインしなくても見られる公開ページに置く。
- **レッスンの内容と料金:** 入会金、月額コースの料金（税込）、回数
- **お支払い方法と、引き落としの時期:** 毎月1日に自動で払うこと
- **特定商取引法に基づく表記（C-1）:** ページの上部か下部からリンクする［F2］
- **プライバシーポリシー:** Stripe の領収書にも URL を載せる必要がある［F9］
- **利用規約:** キャンセル・無断欠席の扱い、休会・退会の連絡方法など
- **連絡先と、問い合わせを受ける時間［F6］**

### A-3. コンビニ払いを使う場合の追加条件（重要）
- **始めて3年未満の個人事業主は、コンビニ払いを使えない［F6］**
  - Stripe のコンビニ払いの禁止業種の一覧に、「事業を始めて3年未満の個人事業主」がある
  - 新しく開く教室で、松田さんが個人事業主として申し込む場合は、コンビニ払いを申し込んでも通らない見込みが高い
  - 法人で申し込むか、コンビニ払いをやめて PayPay・カード・現金にするかを決める必要がある
- **コンビニ払いを使う場合だけの追加条件（コンビニ払いを使わなければ不要）:**
  - 個人事業主は、店舗（教室）の写真をサイトに載せる
  - 特商法の表記の電話番号は固定電話か、固定電話につながる 050 番号にする（携帯電話は不可）［F2］
  - なお、Stripe の申し込みと、コンビニ払いを使わない場合の特商法の表記は、日本語で連絡がつく番号であれば携帯電話でもよい。個人事業主は、住所と電話番号を「請求があれば遅滞なく開示します」とすることもできる［F2］
  - 問い合わせを受ける時間を連絡先と一緒に書く［F2］［F6］
- **サイトに求められること:** 日本語であること。名称・住所・メール・電話が申込みの内容と一致していること。郵便番号があること。解約の条件と、毎月の支払いがあることをはっきり書くこと［F6］

### A-4. PayPay を使う場合
- PayPay 側の審査がある。ダッシュボードの「支払い方法」で有効にし、商品の種類は「標準」を選ぶ。審査はふつう数日、手直しが続くと数週間［F7］
- **サイトに求められること［F7］:**
  - 商品（レッスン）ごとに、画像と日本語の価格を載せる
  - サイトから決済まで進めること。進めない場合は、決済の流れの資料を出す
  - ログインが必要なら、審査用のログイン情報を出す
  - 特商法の表記をヘッダーかフッターからリンクする
  - 名称・住所・法人番号を、国税庁の法人番号公表サイトや Stripe の登録と一致させる（個人事業主の場合の扱いは未確認）
- **PayPay の仕様:**
  - 繰り返しの支払い（自動課金）には使えない
  - 支払いの承認期限は1時間。1回の金額は 50円〜100万円［F8］

### A-5. 手数料と入金
- **手数料（標準）［F10］:**
  - カード: 3.6%
  - コンビニ: 3.6%（最低 120円）
  - PayPay: 3.98%
- **Billing（自動課金）の手数料:** 0.7% が上乗せになる［F10］
- **入金のスケジュール:**
  - 初期設定は「手動」で、最初の入金は、有効化後の最初の支払いから7日後に引き出せるようになる［F3］
  - 毎週か毎月の自動入金に変えておく（B-9）

---

## B. Stripe ダッシュボードで設定すること

テストモード（検証環境）と本番の両方で、同じ設定をする。

1. **支払い方法**（設定 > 支払い方法）
   - カード、コンビニ（A-3 の条件を満たす場合）、PayPay を有効にする
   - 実装は、Checkout の `allowed_payment_method_types` で、ダッシュボードで有効なものの中から絞り込んでいる。そのため、ここで有効にしていない方法の決済画面は作れない［F1］
2. **公開情報**（設定 > ビジネス > ビジネスの詳細）
   - 公開する名称、問い合わせ先、プライバシーポリシーの URL を入れる。領収書に載せる必須の項目である［F9］
   - 「特定商取引法に基づく表記（Commerce disclosures）」のページの URL も登録する。Checkout を使う場合に必要［F2］
3. **明細書の表記**（同じ画面）
   - 英字（5〜22文字）に加えて、漢字（17文字まで）とカナ（22文字まで）の表記も設定する。例: `HANAMARU MUSIC`／`はなまる音楽教室`／`ハナマルオンガクキヨウシツ`
   - カードの明細で、何の支払いか分かるようにする［F11］
4. **領収書のメール**（設定 > ビジネス > カスタマーへのメール）
   - 「支払い成功」を ON にする（MB-07）。Checkout の支払いと、自動課金の請求の両方に領収書が出る［F9］
   - テストモードでは自動では送られない。手動で送って確かめる［F9］
5. **自動課金の失敗・認証のメール**（Billing の設定 > サブスクリプションとメール）
   - 「カード払いが失敗したらメールを送る」: ON
     - こちらの API も失敗のメールを送るので、二重になる。どちらを残すかは D-6 を参照
   - 「支払いの確認（3D セキュア）が必要なときに Stripe のリンクを送る」: ON（C-2）
   - 「無料期間の終了の7日前にお知らせする」: **OFF**
     - 実装は、翌月1日に課金を始めるために無料期間（trial）を使っている。生徒に「無料期間が終わります」と届くと混乱する
   - 「カードの期限切れが近いことを知らせる」: ON を勧める
6. **失敗したときの再試行と、最後の扱い**（Billing の設定 > 支払いの失敗の管理）
   - Smart Retries は ON にしてよい
   - すべての再試行が失敗したあとの扱いは「サブスクリプションをキャンセルする」を勧める
     - キャンセルされると `customer.subscription.deleted` が届き、こちらでは自動課金なしとして扱う
     - 生徒のトップには「カードの登録をお願いします」が出て、登録し直してもらえる（PY-03）
     - 「未払いにする」を選ぶと、請求は作られても支払いが試みられないまま残り、生徒の画面に登録の案内が出ない
7. **カスタマーポータル**
   - 実装はポータルの設定 ID（`STRIPE_PORTAL_CONFIGURATION_ID`）を必ず使い、解約の操作を出さない（PY-13）
   - ダッシュボードの**既定の**ポータル設定は、解約が ON になっている［F12］。Stripe のメールにある「サブスクリプションの管理」のリンクから既定のポータルが開く設定にすると、解約できてしまう
   - 既定のポータル設定でも、「サブスクリプションのキャンセル」と「プランの変更」を OFF にしておく
8. **Webhook の送信先**（開発者 > Webhook）
   - **ダッシュボードでは作らず、`scripts/stripe-setup.ts` に `WEBHOOK_URL` を付けて実行して作る**（対応済み: イベントの一覧と API のバージョンを、コードと同じものにして作る。`docs/operations.md` 1.2）
   - 送信先: `https://student.hanamarumusic.com/api/stripe/webhook`
   - 受け取るイベント:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`
     - `checkout.session.expired`
     - `invoice.paid`
     - `invoice.payment_failed`
     - `invoice.payment_action_required`（3-D セキュアが必要になったとき。D-4）
     - `customer.subscription.deleted`
   - **API のバージョン:** 送信先の API バージョンを、SDK と同じ `2026-09-30.endive` にする
     - 届くデータの形（請求の `parent.subscription_details` など）は、送信先の API バージョンで決まる
     - アカウントの既定のバージョンが SDK と違うと、データの読み取りに失敗する（D-3）
9. **入金のスケジュール**（設定 > 入金のスケジュール）
   - 「手動」から「毎週」か「毎月」に変える［F3］
10. **インボイス**（適格請求書発行事業者の場合だけ。C-4）
    - 請求書の設定で登録番号（JP TRN）を入れ、カスタマーへのメールの設定で「領収書に税 ID を表示する」を ON にする［F13］

---

## C. 法令・ガイドラインで求められること

### C-1. 特定商取引法の表記
- **Stripe で決済するなら必要:** 通信販売に当たらない場合でも、割賦販売法の関係で、Stripe で決済する事業者は表記を載せる必要がある［F2］
- **載せる項目（1ページにまとめる）［F2］:**
  - 事業者の名称（個人は氏名。請求があれば開示する、とすることもできる）
  - 住所と電話番号（個人事業主は、請求があれば開示する、とできる。ただしコンビニ払いの場合は A-3 を参照）
  - メールアドレス、運営責任者
  - 代金以外の費用、返品・キャンセルの条件、役務を提供する時期
  - 支払い方法、支払いの時期、価格（税込）
- **継続して払う契約の書き方:** 月謝は毎月の継続課金なので、契約期間（定めなし、退会の申し出まで）、毎月の金額、支払日、解約の方法と締切をはっきり書く［F2］［F6］

### C-2. クレジットカード・セキュリティガイドライン（割賦販売法）
- **カード情報を持たないこと（非保持化）:**
  - 実装は Stripe Checkout（Stripe の画面）でカードを入力し、カード番号はこちらのサーバーを通らない（2章の7）
  - こちらが持つのは、Stripe の顧客 ID・支払い方法 ID・サブスクリプション ID だけである
  - ガイドラインの「非保持化」に当たる。ガイドラインの本文と照らした確認はしていない（未確認）
- **EMV 3-D セキュアは必須:** 2025年3月末から、日本の EC 加盟店は 3-D セキュア 2.0 が必須［F14］［F15］
  - Stripe は 2025年3月31日から、免除の対象を除くすべての支払いで 3-D セキュアを求めている［F14］
  - 1回払いの Checkout は、何も変えなくてよい［F14］
  - カードの登録だけをする Checkout（setup モード）は、登録のときに既定で 3-D セキュアを行う［F14］
  - 自動課金は、カードの登録か初回の支払いで 3-D セキュアを済ませていれば、2回目以降は免除になりうる。ただし、契約の変更や追加の購入では、もう一度 3-D セキュアが必要になる［F14］。コースの変更（PY-14）の後に認証が必要になることがある
  - 免除で 3-D セキュアをしなかった支払いは、不正利用の責任が教室側に残る［F14］
- **不正利用への対策:**
  - 取引ごとにリスクを判定することが求められている［F14］
  - Stripe Radar の既定のルール（リスクに応じて 3-D セキュアを求めるもの）を ON のままにする
- **脆弱性への対策:** 2025年4月からは、すべての EC 加盟店に「セキュリティ・チェックリスト」の対策が求められている［F15］
  - 管理画面の保護（Cloudflare Access、二段階認証）、更新の適用、ログの監視などは `docs/operations.md` で対応している
  - チェックリストの全項目と照らした確認はしていない（未確認）

### C-3. 特定継続的役務提供
- 対象は、エステ、美容医療、語学教室、家庭教師、学習塾、結婚相手紹介、パソコン教室の7つで、音楽教室は入っていない［F16］
- そのため、クーリング・オフや中途解約のルールはこの制度としてはかからない。ただし、音楽教室が対象外だと明示した消費者庁の文書は見つけていない（未確認）

### C-4. 通信販売の最終確認画面（特商法 12条の6）
- **入会の画面にも当てはまる見込み:** ウェブで有料の申込みを受けるときは、最後の確認画面に次の項目を表示する［F17］。入会の画面（`apps/student/src/pages/Enroll.tsx`）もこれに当たると考えるのが安全である
  - 分量（回数）、代金（定期の場合は各回と総額）、支払いの時期と方法、提供の時期、申込みの撤回・解除の方法
- **D-7 で照合する:** 同意の取り方とあわせて確かめる

### C-5. 個人情報の扱い
- **プライバシーポリシーに書くこと:**
  - 決済のために、Stripe に氏名・メールなどを渡すこと（委託）
  - Stripe が国外でデータを扱う場合は、外国にある第三者への提供について必要な情報（提供先の国、その国の制度、提供先の保護措置）［F18］
- **Stripe との契約の確認:** Stripe（日本法人と米国本社のどちらが受け取るか）の扱いは、Stripe のプライバシーポリシーと契約で確かめる（未確認）

### C-6. インボイス制度
- **教室が適格請求書発行事業者の場合:**
  - Stripe の領収書は、適格簡易請求書として使える［F13］
  - ただし、登録番号の表示と、税率・税額の表示は自動では入らないので、設定が要る［F13］
  - いまの実装は、Checkout の金額にも月額の Price にも税率を付けていない。税率・税額を領収書に出すには、税率の設定（Tax Rate か Stripe Tax）を実装に足す必要がある（D-8）
- **登録していない（免税事業者の）場合:** 適格請求書は出せないので、この設定は不要。教室がどちらに当たるかは税理士に確認する

---

## D. 実装との照合

### OK（そのままでよいもの）
- **カードの登録（setup モード）:**
  - `allowed_payment_method_types: ['card']` と `currency: 'jpy'` を指定している。`apps/api/src/integrations/stripe.ts:79-89`
  - setup モードで `currency` が必須なのは `allowed_payment_method_types` がない場合だけなので、両方あれば問題ない［F1］
  - SetupIntent は既定で off_session 用なので、登録のときに 3-D セキュアが行われる［F14］
- **入会・今月分の Checkout:**
  - `allowed_payment_method_types: [method]` は、ダッシュボードで有効な方法の中から絞り込むためのもので、存在するパラメータである［F1］
  - カードで払うときに `setup_future_usage: 'off_session'` を付けているので、初回の 3-D セキュアで以後の自動課金にも使える
- **コンビニ払いの期限:** 7日（`expires_after_days: 7`）。コンビニ払いは Checkout の payment モードで使え、setup・subscription モードでは使えないので、今の使い方で合っている［F6］
- **自動課金の課金日:**
  - `trial_end` に「1日 00:00 UTC（日本時間 9:00）」を入れている。`apps/api/src/integrations/stripe.ts:136`
  - `trial_end` を設定すると、課金日の基準（billing cycle anchor）は trial の終わりになり、基準は UTC で扱われる［F19］
  - 1日を基準にした月払いは毎月1日に請求される（31日を基準にした場合の月末の調整は、1日には関係しない）［F19］
  - 請求は、`invoice.created` から約1時間後に引き落とされるので、実際は日本時間の10時ごろになる［F20］
- **無料期間中の0円の請求:** 無料期間（trial）でも0円の請求が作られる。`invoice.paid` で金額0のものは無視している。`apps/api/src/domain/billing.ts`（`if (ev.amount === 0)`）
- **解約できない設定:** ポータルの設定 ID がなければ開かない。`apps/api/src/integrations/stripe.ts:143-152`
- **API のバージョン:** SDK `stripe@23.0.0` に `2026-09-30.endive` が固定されている。請求の `parent.subscription_details` はこのバージョンの形で読んでいる

### 要対応

**D-1. 公開サイトの内容（A-2・A-3・A-4）**
- `apps/top/index.html` は、教室名とログインのボタンだけである
- Stripe の有効化、コンビニ払い・PayPay の審査のために、次を載せたページを作る:
  - 料金とレッスンの説明、支払い方法、特商法の表記、プライバシーポリシー、利用規約、問い合わせの時間
- 文面は教室が決める。これがないと審査で止まる可能性が高い

**D-2. Webhook のイベントの一覧に `customer.subscription.deleted` が抜けている** → 対応済み（`WEBHOOK_EVENTS` に一本化し、スクリプトが送信先を作る）
- `docs/operations.md:57-63` と `apps/api/scripts/stripe-setup.ts:9-11` の一覧に足す
- 実装（`parseWebhook`）は処理している

**D-3. Webhook の送信先の API バージョンを固定する** → 対応済み（スクリプトが `api_version: Stripe.API_VERSION` で作る。stripe-mock で確認）
- 送信先をダッシュボードで作ると、アカウントの既定の API バージョンになり、SDK（`2026-09-30.endive`）と違うことがある
- `scripts/stripe-setup.ts` で、送信先を `api_version: '2026-09-30.endive'` を指定して作り、署名シークレットを出力する処理を足すとよい
- 作らない場合は、ダッシュボードで作るときにバージョンを選ぶ手順を `docs/operations.md` に書く

**D-4. 自動課金で 3-D セキュアが必要になったとき** → 対応済み（`invoice.payment_action_required` も失敗と同じに扱い、お支払いの画面のリンクを1通だけ送る。テストモードでの確認は E 章で引き続き行う）
- 2回目以降の引き落としで認証が必要になると、Stripe は `invoice.payment_action_required` と `invoice.payment_failed` を送る［F20］
- 実装は `invoice.payment_failed` を処理し、Stripe の請求の支払いページのリンク（hosted invoice URL）を「カードの更新または再認証」としてメールで送る。`apps/api/src/domain/billing.ts:515-545`
- 認証が必要なときにも `invoice.payment_failed` が届くかは、テストモードで確かめる（E-4）。届かない場合は、`invoice.payment_action_required` も `invoice_failed` と同じに扱うよう `parseWebhook`（`apps/api/src/integrations/stripe.ts:199-208`）に足す

**D-5. Stripe の「無料期間の終了」のメール**
- 無料期間を課金日合わせに使っているため、B-5 で OFF にする（コードの変更は不要）
- コードで避けるなら、`trial_end` の代わりに `billing_cycle_anchor` と `proration_behavior: 'none'` を使う方法がある［F19］
  - この方法なら、1日までの期間は無料で、請求も作られない
  - ただし、作成した時点で `status` が `active` になる。`findLiveSubscription` などの判定と、テストの修正が要る

**D-6. 失敗のメールが何通も届く** → 対応済み（最初に失敗したときの1通だけ。Stripe 側の失敗のメールを OFF にするかは教室が決める）
- `invoice_failed` を受けるたびに、失敗のメールを送っている。`apps/api/src/domain/billing.ts:520`
- Smart Retries で再試行が失敗するたびに届き、Stripe の失敗のメール（B-5）とも重なる
- 案: 支払いの状態が `pending` から `failed` に変わったときだけ送る（`p.status !== 'failed'` のときだけ送る）。どちらか一方のメールに絞る

**D-7. 入会の画面の表示と同意（C-4・利用規約）** → 対応済み（契約の内容を表示し、同意のチェックがないと支払いに進めない。同意の日時を操作記録に残す。利用規約の URL は `TERMS_URL`。規約の文面は教室が決める）
- `apps/student/src/pages/Enroll.tsx` には、金額・回数・翌月からの月額・毎月1日の支払いが出ている
- 次のものがない:
  - 「契約期間（退会の申し出まで）」
  - 「退会・休会の方法と締切（翌月1日から）」
  - 利用規約への同意（要件定義書 8.2「入会時に同意を取る」）
- 支払うボタンの前に、これらの表示と、規約のリンク付きの同意のチェックを足す（文面は教室が決める）

**D-8. 税率の表示（適格請求書発行事業者の場合だけ）**
- `createCheckout`（`apps/api/src/integrations/stripe.ts:52-62`）の `price_data` と、`createMonthlyPrice`（`:96-110`）に、税込（`tax_behavior: 'inclusive'`）の価格と 10% の税率を付ける必要がある
- 免税事業者なら不要

**D-9. コンビニ払いが使えない場合**
- A-3 の条件で申し込めない場合は、支払い方法の選択肢（入会の画面、管理画面の支払い方法、`billingMethod` の `konbini`）を設定で隠せるようにするかを決める（要件定義書 PY-04 の見直し）

---

**D-10. 決済画面の期限（24時間）と、変則的な流れ** → 対応済み
- Checkout の画面は最長24時間で期限が切れる。毎月1日に送るコンビニ・PayPay のリンクも、翌日には使えなくなる
- 生徒のトップの「お支払い画面を開く」（メールの `?billing=pay`）から、同じ請求の画面を作り直せる。作り直しの冪等キーには古い画面の ID を入れ、同時に押されても Stripe 側で1つにまとまる
- 連打・2つのタブ、月またぎ、二重の入金、通知の重複・順番の入れ替わり、Stripe の呼び出しの失敗などは `apps/api/test/edge-cases.test.ts` で確かめている（要件定義書 3.11）
- テストモードでは、コンビニ払いの番号を出したあとの画面の扱い（期限切れ前に開き直したときに、Stripe が何を表示するか）を確かめる

## E. テストモードで確かめる手順

テストモードのキー（`sk_test_`）だけを使う。本番のキーは使わない（7.3）。

### E-1. 準備
1. B の設定をテストモードで行う
2. `STRIPE_SECRET_KEY=sk_test_... pnpm --filter @hanamaru/api exec tsx scripts/stripe-setup.ts` を実行し、ポータルの設定 ID を入れる
3. Stripe CLI で Webhook を手元に転送する: `stripe listen --forward-to localhost:3000/api/stripe/webhook`。表示された署名シークレットを `STRIPE_WEBHOOK_SECRET` に入れる

### E-2. テストカード［F21］
| 番号 | 動き |
|---|---|
| 4242 4242 4242 4242 | 成功 |
| 4000 0039 2000 0003 | 日本の Visa（明細書の漢字・カナの確認用） |
| 3530 1113 3330 0000 | 日本の JCB |
| 4000 0025 0000 3155 | 登録時に認証が要る。登録後の off_session の課金は認証なしで成功する（**ふつうの流れ**） |
| 4000 0027 6000 3184 | 毎回認証が要る（**自動課金で認証が必要になる場合**の確認用） |
| 4000 0000 0000 9995 | 残高不足で失敗 |
| 4000 0000 0000 0341 | 登録はできるが、課金は失敗する（**自動課金の失敗**の確認用） |

### E-3. テストクロックで月をまたぐ
1. **テストクロックを作る:** ダッシュボードの「サブスクリプション > シミュレーション」で、開始時刻を「11月30日 10:00（日本時間）」にする［F20］
   - API で作る場合は、Customer を `test_clock` 付きで作る
   - いまの実装は Customer に `test_clock` を付けない。手で作った Customer の ID を、検証用の DB の `students.stripe_customer_id` に入れて試す
2. 入会（カード 4000 0025 0000 3155）を済ませ、サブスクリプションの `trial_end` が「12月1日 00:00 UTC」になっていることを確かめる
3. クロックを「12月1日 11:00（日本時間）」まで進める
   - `invoice.paid` が届き、管理画面の入金状況で 12月分が入金済み、回数が付いていることを確かめる
4. 「1月1日 11:00」、「2月1日 11:00」、「3月1日 11:00」と進める
   - 一度に進められるのは2回の請求分までなので、1か月ずつ進める［F20］
   - それぞれの月の分が、その月として記録されることを確かめる（PY-03・PY-05）
   - とくに 12月→1月 と 2月→3月 を見る
5. **失敗の流れ:**
   - 別の生徒で 4000 0000 0000 0341 を登録し、1日まで進める
   - `invoice.payment_failed` → 失敗のメール → 猶予の翌日（8日 0:00）に予約が取り消されること（PY-10・PY-11）を確かめる
6. **認証の流れ:**
   - 4000 0027 6000 3184 で登録し、1日まで進める
   - `invoice.payment_failed` と `invoice.payment_action_required` のどちらが届くかを Stripe CLI のログで確かめる（D-4）
   - メールのリンクから認証して支払えることを確かめる
7. **カードの登録だけ（PY-03）:**
   - 管理画面で生徒をカード払いに切り替える
   - メールのリンクから setup モードの画面を開き、4000 0025 0000 3155 で登録する
   - `checkout.session.completed`（mode=setup）でサブスクリプションが作られることを確かめる
8. **退会・休会（ST-05）:**
   - 予定を入れると `cancel_at_period_end` になり、取りやめると元に戻ることを確かめる
   - 月末を越えると `customer.subscription.deleted` が届くことを確かめる

### E-4. コンビニ払い・PayPay
- **コンビニ払い:**
  - Checkout でコンビニを選び、テストモードで支払いを完了させる
  - `checkout.session.completed`（未払い）のあとに `checkout.session.async_payment_succeeded` が届き、回数が付くことを確かめる（PY-16）
  - 期限切れの流れでは、`checkout.session.async_payment_failed` で失敗になることを確かめる
  - テストモードでの具体的な操作（メールアドレスの書き方など）は、Stripe のコンビニ払いのテストの説明に従う（未確認）
- **PayPay:**
  - テストモードの決済画面で「承認」「失敗」を選べることと、1時間の期限を確かめる（テストでの具体的な操作は未確認）

### E-5. 領収書
- テストモードでは自動で送られない。ダッシュボードの支払いの詳細から手動で送り、名称・問い合わせ先・プライバシーポリシーの URL（と、必要なら登録番号・税額）が載っていることを確かめる［F9］

---

## F. 出典（確認日はすべて 2026年10月20日）

1. Stripe API リファレンス「Create a Checkout Session」 https://docs.stripe.com/api/checkout/sessions/create
2. Stripe サポート「How to create and display a "Commerce Disclosure" page」 https://support.stripe.com/questions/details-and-requirements-under-the-specified-commercial-transactions-act
3. Stripe サポート「Getting started in Japan」 https://support.stripe.com/questions/getting-started-in-japan
4. Stripe サポート「Add a bank account for payouts in Japan」ほか、検索結果の要約 https://support.stripe.com/questions/add-a-bank-account-for-payouts-in-japan
5. Stripe サポート「Who can create an account in Japan?」 https://support.stripe.com/questions/who-can-create-an-account-in-japan
6. Stripe ドキュメント「Konbini payments」（Onboarding requirements、Prohibited business categories） https://docs.stripe.com/payments/konbini
7. Stripe サポート「Accept PayPay payments with a Japan-based Stripe account」 https://support.stripe.com/questions/accept-paypay-payments-with-a-japan-based-stripe-account
8. Stripe ドキュメント「PayPay payments」 https://docs.stripe.com/payments/paypay
9. Stripe ドキュメント「Receipts and paid invoices」 https://docs.stripe.com/receipts
10. Stripe 料金（日本） https://stripe.com/ja-jp/pricing
11. Stripe ドキュメント「Statement descriptors」（Set Japanese statement descriptors） https://docs.stripe.com/get-started/account/statement-descriptors
12. Stripe ドキュメント「Configure the customer portal」 https://docs.stripe.com/customer-management/configure-portal
13. Stripe ガイド「Best practices for setting up invoices in Japan」 https://stripe.com/en-cn/guides/best-practices-for-setting-up-invoicies-in-japan
14. Stripe サポート「3DS mandate in Japan」 https://support.stripe.com/questions/3ds-mandate-in-japan
15. ネットショップ担当者フォーラム・ペイメントナビ（クレジットカード・セキュリティガイドライン 5.0版の報道） https://netshop.impress.co.jp/node/12342 ／ https://paymentnavi.com/paymentnews/144091.html
16. 広島県「特定継続的役務提供」、消費者委員会資料 https://www.pref.hiroshima.lg.jp/soshiki/41/chuutokaiyaku.html ／ https://www.cao.go.jp/consumer/iinkai/2021/335/doc/20210114_sankou1.pdf
17. 通信販売の申込み段階の表示（12条の6）に関する解説（群馬県資料ほか） https://www.pref.gunma.jp/uploaded/attachment/651749.pdf
18. 個人情報保護委員会 FAQ（外国にある第三者への提供） https://www.ppc.go.jp/all_faq_index/faq2-q5-8
19. Stripe ドキュメント「Set the subscription billing renewal date」、API リファレンス「Create a subscription」 https://docs.stripe.com/billing/subscriptions/billing-cycle ／ https://docs.stripe.com/api/subscriptions/create
20. Stripe ドキュメント「Using webhooks with subscriptions」「Simulate subscriptions」「Automate customer emails」 https://docs.stripe.com/billing/subscriptions/webhooks ／ https://docs.stripe.com/billing/testing/test-clocks/simulate-subscriptions ／ https://docs.stripe.com/billing/revenue-recovery/customer-emails
21. Stripe ドキュメント「Testing」 https://docs.stripe.com/testing
