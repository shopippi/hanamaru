import { useState } from 'react';
import { Button, Checkbox, Loadable, Notice, Skeleton, Warning, fmtYen, useAction, useLoad, useOnline, useToast } from '@hanamaru/ui';
import { TERMS_URL, api } from '../api.js';
import { InAppBrowserNotice } from '../notices.js';
import { useStudent } from '../student-context.js';

// 入会手続き・支払い（PY-01〜04）。お支払いは Stripe の画面で行い、カード情報はこちらを通らない（2章の7）

interface Options {
  status: string;
  packages: { id: string; name: string; lessonCount: number; admissionFee: number; lessonsPrice: number; total: number }[];
  course: { name: string; lessonsPerMonth: number; amount: number | null } | null;
  methods: { method: 'card' | 'konbini' | 'paypay'; label: string; recommended: boolean }[];
  terms: { cancelDeadlineHours: number; graceDays: number };
}

export function Enroll() {
  const { current } = useStudent();
  const toast = useToast();
  const online = useOnline();
  const { state, reload } = useLoad(() => api.get<Options>(`/students/${current.id}/enrollment`), [current.id]);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [method, setMethod] = useState<Options['methods'][number]['method']>('card');
  // 契約の内容と利用規約への同意（お支払いの前の最終確認）
  const [agreed, setAgreed] = useState(false);
  const cancelled = new URLSearchParams(location.search).get('checkout') === 'cancel';

  const pay = useAction(async (pkg: string) => {
    try {
      const { url } = await api.post<{ url: string }>(`/students/${current.id}/enrollment`, { packageId: pkg, method, agreed });
      // 決済画面（Stripe）へ。支払い後は自動でこのアプリに戻る（PW-06）
      location.assign(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : '手続きを始められませんでした', 'error');
    }
  });

  return (
    <div className="stack">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div className="page-header-text">
          <h1>入会手続き</h1>
          <p>入会セットとお支払い方法を選んでください。お支払いが済むと予約できます。</p>
        </div>
      </div>
      <InAppBrowserNotice />
      {cancelled && <Notice>お支払いは完了していません。もう一度お手続きください。</Notice>}
      <Loadable state={state} reload={reload} skeleton={<Skeleton block />}>
        {(o) => {
          if (o.status !== 'enrolling') return <Notice>入会手続きは済んでいます。</Notice>;
          if (!o.course) return <Warning title="月額コースが決まっていません">教室がコースを設定すると、入会手続きができます。教室にお問い合わせください。</Warning>;
          const selected = o.packages.find((p) => p.id === (packageId ?? o.packages[0]?.id));
          return (
            <form
              className="stack-lg"
              onSubmit={(e) => {
                e.preventDefault();
                if (selected) void pay.run(selected.id);
              }}
            >
              <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field-label">入会セットを選ぶ</legend>
                {o.packages.map((p) => (
                  <label key={p.id} className="choice">
                    <input type="radio" name="package" value={p.id} checked={selected?.id === p.id} onChange={() => setPackageId(p.id)} />
                    <span className="list-row-main">
                      <span className="list-title">{p.name}</span>
                      <span className="list-meta">
                        入会金 {fmtYen(p.admissionFee)}＋レッスン{p.lessonCount}回 {fmtYen(p.lessonsPrice)}
                      </span>
                    </span>
                    <span className="choice-price num">
                      {fmtYen(p.total)}
                      <small>税込</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <Notice>
                翌月からは「{o.course.name}」（月{o.course.lessonsPerMonth}回{o.course.amount !== null ? `・${fmtYen(o.course.amount)}（税込）` : ''}）を毎月1日にお支払いいただきます。日割りはありません。
              </Notice>
              <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field-label">お支払い方法</legend>
                {o.methods.map((m) => (
                  <label key={m.method} className="choice">
                    <input type="radio" name="method" value={m.method} checked={method === m.method} onChange={() => setMethod(m.method)} />
                    <span>
                      {m.recommended && <span className="badge badge-solid" style={{ marginRight: 8 }}>おすすめ</span>}
                      {m.label}
                    </span>
                  </label>
                ))}
                <p className="small secondary">現金でのお支払いをご希望の場合は、教室にご相談ください。</p>
              </fieldset>
              <section className="stack-sm" aria-labelledby="terms-title">
                <h2 className="field-label" id="terms-title">
                  契約の内容
                </h2>
                <dl className="summary prose">
                  <div>
                    <dt>期間</dt>
                    <dd>退会のお申し出まで、毎月続きます</dd>
                  </div>
                  <div>
                    <dt>月謝</dt>
                    <dd>
                      {o.course.name}
                      {o.course.amount !== null ? `・${fmtYen(o.course.amount)}（税込）` : ''}。翌月から毎月1日にお支払いいただきます。日割りはありません
                    </dd>
                  </div>
                  <div>
                    <dt>退会・休会</dt>
                    <dd>教室にご連絡ください。お申し出の翌月1日から止まります。お支払い済みの月は月末まで予約でき、返金はありません</dd>
                  </div>
                  <div>
                    <dt>キャンセル</dt>
                    <dd>レッスンの{o.terms.cancelDeadlineHours}時間前までは回数をお戻しします。それより後のキャンセルと無断欠席は、回数を使います</dd>
                  </div>
                  <div>
                    <dt>未払い</dt>
                    <dd>毎月1日から{o.terms.graceDays}日たってもお支払いを確認できない場合、その月のご予約は取り消しになります</dd>
                  </div>
                </dl>
                <Checkbox label="契約の内容と利用規約に同意します" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                {TERMS_URL && (
                  <p className="small">
                    <a href={TERMS_URL} target="_blank" rel="noreferrer">
                      利用規約を読む
                    </a>
                  </p>
                )}
              </section>
              {selected && (
                <Button type="submit" block pending={pay.pending} disabled={!online || !agreed} pendingLabel="お支払い画面へ移動しています…">
                  {fmtYen(selected.total)}（税込）を支払う
                </Button>
              )}
              <p className="small muted">領収書は決済サービス（Stripe）からメールでお送りします。解約・休会は教室にご連絡ください。</p>
            </form>
          );
        }}
      </Loadable>
    </div>
  );
}
