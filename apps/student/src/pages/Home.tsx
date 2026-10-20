import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Loadable, Notice, Skeleton, Warning, fmtDate, fmtMonthShort, fmtTimeRange, useAction, useLoad, useToast } from '@hanamaru/ui';
import { api, type Home as HomeData } from '../api.js';
import { AddToHomeGuide } from '../notices.js';
import { useStudent } from '../student-context.js';

// 生徒のトップ。今月の残り回数・次の予約・お支払い状況を大きく出し、1画面で状況が分かる（MB-01）

const PAYMENT_LABEL: Record<HomeData['payment'], string> = {
  paid: 'お支払い済み',
  confirming: 'お支払いを確認中',
  unpaid: '未払い',
  failed: 'お支払いができていません',
  none: '請求はまだありません',
};

function HomeSkeleton() {
  return (
    <div className="stack">
      <div className="card">
        <Skeleton width="40%" />
        <div className="skeleton" style={{ height: 48, width: '30%', marginTop: 8 }} />
      </div>
      <div className="card">
        <Skeleton lines={2} />
      </div>
      <div className="card">
        <Skeleton lines={1} />
      </div>
      <div className="skeleton" style={{ height: 52 }} />
    </div>
  );
}

export function Home() {
  const { current } = useStudent();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const checkout = params.get('checkout');
  const { state, reload, data } = useLoad(() => api.get<HomeData>(`/students/${current.id}/home`), [current.id]);

  // 決済画面から戻ったら、入金確定の通知が届くまで数秒おきに確かめる（PY-05、PW-06）
  useEffect(() => {
    if (checkout !== 'done' || !data || data.payment !== 'confirming') return;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [checkout, data, reload]);

  const portal = useAction(async () => {
    try {
      const { url } = await api.post<{ url: string }>(`/students/${current.id}/billing-portal`);
      location.assign(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : '開けませんでした', 'error');
    }
  });
  // 決済失敗のメールのリンク（?billing=update）から開いたら、カード管理画面へ（PY-11、MB-04）
  useEffect(() => {
    if (params.get('billing') === 'update') {
      setParams({}, { replace: true });
      void portal.run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Loadable state={state} reload={reload} skeleton={<HomeSkeleton />}>
      {(h) => (
        <div className="stack">
          <h1 className="visually-hidden">{h.student.name}さんのホーム</h1>
          {checkout === 'done' && h.payment === 'confirming' && (
            <Notice icon="⏳">お支払いを確認しています。確認できると回数が付きます。この画面のままお待ちください。</Notice>
          )}
          {h.student.status === 'enrolling' ? (
            <section className="card stack">
              <h2>入会手続き</h2>
              <p>入会セットのお支払いが済むと、レッスンを予約できます。</p>
              <Link className="btn btn-primary btn-block" to="/enroll">
                入会手続きへ進む
              </Link>
            </section>
          ) : (
            <>
              <section className="card" aria-labelledby="remaining-title">
                <h2 className="card-title" id="remaining-title">
                  {fmtMonthShort(h.month)}の残り回数
                </h2>
                <p className="big-number num" style={{ margin: 0 }}>
                  {h.remaining}
                  <small>回</small>
                </p>
                {h.nextMonth.remaining > 0 && (
                  <p className="small muted" style={{ margin: 0 }}>
                    {fmtMonthShort(h.nextMonth.month)}分: あと{h.nextMonth.remaining}回予約できます
                  </p>
                )}
              </section>
              <section className="card" aria-labelledby="next-title">
                <h2 className="card-title" id="next-title">
                  次の予約
                </h2>
                {h.nextReservation ? (
                  <p style={{ margin: 0 }}>
                    <strong style={{ fontSize: 20 }}>
                      {fmtDate(h.nextReservation.startsAt)} {fmtTimeRange(h.nextReservation.startsAt, h.nextReservation.endsAt)}
                    </strong>
                    <br />
                    {h.nextReservation.teacherName}・{h.nextReservation.lessonTypeName}
                    {h.nextReservation.status === 'pending' && <span className="badge" style={{ marginLeft: 8 }}>仮予約</span>}
                  </p>
                ) : (
                  <p style={{ margin: 0 }}>予約はまだありません</p>
                )}
              </section>
              <section className="card" aria-labelledby="pay-title">
                <h2 className="card-title" id="pay-title">
                  お支払い状況（{fmtMonthShort(h.month)}）
                </h2>
                <p style={{ margin: 0 }}>
                  <strong>{PAYMENT_LABEL[h.payment]}</strong>
                  {h.autopay && <span className="small muted">（毎月1日に自動でお支払い）</span>}
                </p>
                {(h.payment === 'failed' || h.autopay) && (
                  <Button variant={h.payment === 'failed' ? 'primary' : 'secondary'} onClick={() => void portal.run()} pending={portal.pending} style={{ marginTop: 8 }}>
                    カードを変更する
                  </Button>
                )}
              </section>
              {h.blocker ? (
                <>
                  <Warning title={h.blocker} />
                  <Button block disabled>
                    予約する
                  </Button>
                </>
              ) : (
                <Link className="btn btn-primary btn-block" to="/book">
                  予約する
                </Link>
              )}
              {h.student.scheduledStatus && h.student.scheduledStatusAt && (
                <Notice>
                  {fmtDate(h.student.scheduledStatusAt)}から{h.student.scheduledStatus === 'suspended' ? '休会' : '退会'}となります。
                </Notice>
              )}
            </>
          )}
          <AddToHomeGuide />
          <p className="small muted">解約・休会は教室にご連絡ください。</p>
        </div>
      )}
    </Loadable>
  );
}
