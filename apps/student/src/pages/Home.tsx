import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Button,
  DateTile,
  IconCard,
  IconCheckCircle,
  IconChevronRight,
  IconClock,
  Loadable,
  Notice,
  Skeleton,
  Warning,
  fmtDate,
  fmtMonthShort,
  fmtTimeRange,
  useAction,
  useLoad,
  useToast,
} from '@hanamaru/ui';
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
      <div className="card hero">
        <Skeleton width="40%" />
        <div className="skeleton" style={{ height: 62, width: '35%', marginTop: 8 }} />
        <div className="skeleton" style={{ height: 6, marginTop: 16 }} />
      </div>
      <div className="skeleton" style={{ height: 52 }} />
      <div className="panel">
        <div className="panel-body">
          <Skeleton lines={2} />
        </div>
        <div className="panel-body" style={{ borderTop: '1px solid var(--border)' }}>
          <Skeleton lines={1} />
        </div>
      </div>
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
  const [polls, setPolls] = useState(0);
  const waitingPayment = checkout === 'done' && !!data && data.payment !== 'paid' && data.payment !== 'none' && polls < 40;
  useEffect(() => {
    if (!waitingPayment) return;
    const t = setTimeout(() => (setPolls((n) => n + 1), reload()), 3000);
    return () => clearTimeout(t);
  }, [waitingPayment, data, reload]);

  // コンビニ・PayPay の今月分の決済画面を開く（PY-16）。メールのリンク（?billing=pay）からも開く
  const monthlyPay = useAction(async () => {
    try {
      const { url } = await api.post<{ url: string }>(`/students/${current.id}/monthly-payment`);
      location.assign(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : '開けませんでした', 'error');
    }
  });

  const portal = useAction(async () => {
    try {
      const { url } = await api.post<{ url: string }>(`/students/${current.id}/billing-portal`);
      location.assign(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : '開けませんでした', 'error');
    }
  });
  // カードの登録（PY-03）。今月分が未払いなら、その支払いと一緒に登録する
  const register = useAction(async () => {
    try {
      const { url } = await api.post<{ url: string }>(`/students/${current.id}/card-registration`);
      location.assign(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : '開けませんでした', 'error');
    }
  });
  const cardDone = params.get('card') === 'done';
  // 登録の画面から戻ったら、登録の通知が届くまで数秒おきに確かめる
  useEffect(() => {
    if (!cardDone || !data?.needsCard) return;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [cardDone, data, reload]);

  // 決済失敗のメールのリンク（?billing=update）から開いたら、カード管理画面へ（PY-11、MB-04）。
  // カード登録のお願いのメールのリンク（?billing=register）から開いたら、カードの登録へ
  useEffect(() => {
    if (params.get('billing') === 'update') {
      setParams({}, { replace: true });
      void portal.run();
    }
    if (params.get('billing') === 'register') {
      setParams({}, { replace: true });
      void register.run();
    }
    if (params.get('billing') === 'pay') {
      setParams({}, { replace: true });
      void monthlyPay.run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Loadable state={state} reload={reload} skeleton={<HomeSkeleton />}>
      {(h) => (
        <div className="stack">
          <h1 className="visually-hidden">{h.student.name}さんのホーム</h1>
          {cardDone && (
            <Notice icon={h.needsCard ? <IconClock /> : <IconCheckCircle />}>
              {h.needsCard ? 'カードの登録を確認しています。この画面のままお待ちください。' : 'カードを登録しました。翌月1日から毎月自動でお支払いいただきます。'}
            </Notice>
          )}
          {h.needsCard && !cardDone && (
            <Warning title="カードの登録をお願いします">
              <div className="stack-sm">
                <p>月謝はカードの自動払いです。カードを登録すると、翌月1日から毎月自動でお支払いいただきます。{h.payment === 'unpaid' || h.payment === 'failed' ? '今月分のお支払いも、登録と一緒に行います。' : ''}</p>
                <div>
                  <Button variant="secondary" onClick={() => void register.run()} pending={register.pending} pendingLabel="登録の画面へ移動しています…">
                    <IconCard size={18} />
                    カードを登録する
                  </Button>
                </div>
              </div>
            </Warning>
          )}
          {checkout === 'done' && h.payment !== 'paid' && h.payment !== 'none' && (
            <Notice icon={<IconClock />}>
              お支払いを確認しています。確認できると回数が付きます。この画面のままお待ちください。
              {h.paymentLinkAvailable && 'コンビニ払いの場合は、店頭でお支払いいただいたあとに回数が付きます。'}
            </Notice>
          )}
          {h.student.status === 'enrolling' ? (
            <section className="card hero stack">
              <p className="card-title">はじめに</p>
              <h2>入会手続き</h2>
              <p className="secondary">入会セットのお支払いが済むと、レッスンを予約できます。</p>
              <Link className="btn btn-primary btn-block" to="/enroll">
                入会手続きへ進む
              </Link>
            </section>
          ) : (
            <>
              <section className="card hero" aria-labelledby="remaining-title">
                <div className="spread">
                  <h2 className="card-title" id="remaining-title">
                    {fmtMonthShort(h.month)}の残り回数
                  </h2>
                  {h.course && <span className="badge">{h.course.name}</span>}
                </div>
                <p className="big-number num">
                  {h.remaining}
                  <small>回</small>
                </p>
                {h.course && h.course.lessonsPerMonth > 0 && (
                  <div className="meter" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, (h.remaining / h.course.lessonsPerMonth) * 100)}%` }} />
                  </div>
                )}
                {h.nextMonth.remaining > 0 && (
                  <p className="small muted hero-foot">
                    {fmtMonthShort(h.nextMonth.month)}分: あと{h.nextMonth.remaining}回予約できます
                  </p>
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
              <div className="panel">
                <section className="panel-body" aria-labelledby="next-title">
                  <h2 className="card-title" id="next-title">
                    次の予約
                  </h2>
                  {h.nextReservation ? (
                    <Link className="list-row next-lesson" to="/reservations">
                      <DateTile at={h.nextReservation.startsAt} />
                      <span className="list-row-main">
                        <span className="list-title">
                          {fmtDate(h.nextReservation.startsAt)} {fmtTimeRange(h.nextReservation.startsAt, h.nextReservation.endsAt)}
                        </span>
                        <span className="list-meta">
                          {h.nextReservation.teacherName}・{h.nextReservation.lessonTypeName}
                          {h.nextReservation.status === 'pending' && <span className="badge" style={{ marginLeft: 8 }}>仮予約</span>}
                        </span>
                      </span>
                      <IconChevronRight className="muted" />
                    </Link>
                  ) : (
                    <p className="secondary">予約はまだありません</p>
                  )}
                </section>
                <section className="panel-body panel-divider" aria-labelledby="pay-title">
                  <h2 className="card-title" id="pay-title">
                    お支払い状況（{fmtMonthShort(h.month)}）
                  </h2>
                  <div className="spread">
                    <p>
                      <span className={h.payment === 'failed' || h.payment === 'unpaid' ? 'badge badge-strong' : 'badge badge-dot'}>{PAYMENT_LABEL[h.payment]}</span>
                    </p>
                    {h.paymentLinkAvailable ? (
                      <Button variant={h.payment === 'failed' ? 'primary' : 'secondary'} onClick={() => void monthlyPay.run()} pending={monthlyPay.pending} pendingLabel="開いています…">
                        お支払い画面を開く
                      </Button>
                    ) : h.cardPaymentDue && !h.needsCard ? (
                      <Button variant={h.payment === 'failed' ? 'primary' : 'secondary'} onClick={() => void register.run()} pending={register.pending} pendingLabel="開いています…">
                        <IconCard size={18} />
                        今月分をカードで払う
                      </Button>
                    ) : (h.payment === 'failed' || h.autopay) && !h.needsCard && (
                      <Button variant={h.payment === 'failed' ? 'primary' : 'quiet'} onClick={() => void portal.run()} pending={portal.pending}>
                        <IconCard size={18} />
                        カードを変更する
                      </Button>
                    )}
                  </div>
                  {h.autopay && <p className="small muted">毎月1日に自動でお支払いします</p>}
                </section>
              </div>
              {h.student.scheduledStatus && h.student.scheduledStatusAt && (
                <Notice>
                  {fmtDate(h.student.scheduledStatusAt)}から{h.student.scheduledStatus === 'suspended' ? '休会' : '退会'}となります。
                </Notice>
              )}
            </>
          )}
          <AddToHomeGuide />
          <p className="small muted center">解約・休会は教室にご連絡ください。</p>
        </div>
      )}
    </Loadable>
  );
}
