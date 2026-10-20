import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Checkbox,
  Empty,
  Loadable,
  METHOD_LABEL,
  Notice,
  Select,
  Skeleton,
  TextField,
  addDaysKey,
  dateKey,
  fmtDateKey,
  fmtDateTime,
  fmtMonth,
  fmtYen,
  monthKey,
  useAction,
  useLoad,
  useToast,
} from '@hanamaru/ui';
import { api, type Course, type Package, type StudentRow } from '../api.js';

// 入金状況（PY-09）、現金の入金（PY-06）、CSV（PY-15）、単発の請求（PY-17）、料金（PY-01、PY-02、PY-14）

interface PaymentRow {
  paymentId: string;
  studentId: string;
  studentName: string;
  method: string;
  amount: number;
  status: string;
  paidAt: string | null;
  graceDaysLeft: number | null;
}

export function Payments() {
  const toast = useToast();
  const [month, setMonth] = useState(monthKey(new Date()));
  const [unpaid, setUnpaid] = useState(false);
  const { state, reload } = useLoad(() => api.get<PaymentRow[]>(`/payments?month=${month}${unpaid ? '&unpaid=1' : ''}`), [month, unpaid]);
  const cash = useAction(async (p: PaymentRow) => {
    try {
      await api.post('/payments/cash', { studentId: p.studentId, month });
      toast(`${p.studentName}さんを入金済みにしました`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '記録できませんでした', 'error');
    }
  });
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(dateKey(new Date()));
  return (
    <div className="stack-lg">
      <h1>入金状況</h1>
      <div className="row">
        <input aria-label="対象月" type="month" className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} />
        <Checkbox label="未払い・決済失敗だけ" checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} />
      </div>
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty message={unpaid ? '未払いの生徒はいません' : `${fmtMonth(month)}の請求はまだありません（毎月1日に作られます）`} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">生徒</th>
                    <th scope="col">方法</th>
                    <th scope="col">金額（税込）</th>
                    <th scope="col">状態</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.paymentId}>
                      <td>
                        <Link to={`/students/${p.studentId}`}>{p.studentName}</Link>
                      </td>
                      <td>{METHOD_LABEL[p.method]}</td>
                      <td className="num">{fmtYen(p.amount)}</td>
                      <td>
                        {p.status === 'succeeded' ? (
                          `入金済み（${p.paidAt ? fmtDateTime(p.paidAt) : ''}）`
                        ) : (
                          <strong>
                            {p.status === 'failed' ? '⚠ 決済失敗' : '未払い'}
                            {p.graceDaysLeft !== null && (p.graceDaysLeft > 0 ? `（猶予あと${p.graceDaysLeft}日）` : '（猶予切れ）')}
                          </strong>
                        )}
                      </td>
                      <td>
                        {p.status !== 'succeeded' && (
                          <Button variant="secondary" onClick={() => void cash.run(p)} pending={cash.pending} pendingLabel="…">
                            現金で入金済み
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loadable>
      <section className="card stack">
        <h2>入金履歴のCSV</h2>
        <div className="row">
          <input aria-label="開始日" type="date" className="input" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>〜</span>
          <input aria-label="終了日" type="date" className="input" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <a className="btn btn-secondary" href={`/api/payments.csv?from=${from}&to=${to}`} download>
          CSVを書き出す
        </a>
      </section>
    </div>
  );
}

export function Charges() {
  const toast = useToast();
  const list = useLoad(() => api.get<{ id: string; title: string; amount: number; dueDate: string | null; total: number; paid: number }[]>('/charges'), []);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack-lg">
      <div className="spread">
        <h1 style={{ margin: 0 }}>単発の請求</h1>
        <Button onClick={() => setCreating(!creating)}>請求を作る</Button>
      </div>
      {creating && <NewCharge onDone={() => (setCreating(false), list.reload(), toast('請求を作りました'))} />}
      <Loadable state={list.state} reload={list.reload} skeleton={<Skeleton lines={5} />}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty message="単発の請求はありません（教材費・発表会費など）" action={<Button onClick={() => setCreating(true)}>請求を作る</Button>} />
          ) : (
            <ul className="list">
              {rows.map((c) => (
                <li key={c.id} className="stack">
                  <button type="button" className="choice" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                    <span>
                      <strong>{c.title}</strong>　{fmtYen(c.amount)}
                      <br />
                      <span className="small">
                        入金済み {c.paid} / {c.total}人{c.dueDate ? `・期限 ${fmtDateKey(c.dueDate)}` : ''}
                      </span>
                    </span>
                  </button>
                  {open === c.id && <ChargeItems chargeId={c.id} onChanged={list.reload} />}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
    </div>
  );
}

function ChargeItems({ chargeId, onChanged }: { chargeId: string; onChanged: () => void }) {
  const toast = useToast();
  const { state, reload } = useLoad(() => api.get<{ items: { id: string; studentName: string; amount: number; paid: boolean }[] }>(`/charges/${chargeId}`), [chargeId]);
  const pay = useAction(async (id: string) => {
    await api.post(`/charge-items/${id}/paid`);
    toast('入金済みにしました');
    reload();
    onChanged();
  });
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={3} />}>
      {(d) => (
        <table className="table">
          <tbody>
            {d.items.map((i) => (
              <tr key={i.id}>
                <td>{i.studentName}</td>
                <td>{i.paid ? '入金済み' : <strong>未払い</strong>}</td>
                <td>
                  {!i.paid && (
                    <Button variant="secondary" onClick={() => void pay.run(i.id)} pending={pay.pending} pendingLabel="…">
                      入金済みにする
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Loadable>
  );
}

function NewCharge({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const students = useLoad(() => api.get<StudentRow[]>('/students?status=active'), []);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(addDaysKey(dateKey(new Date()), 14));
  const [ids, setIds] = useState<string[]>([]);
  const save = useAction(async () => {
    try {
      await api.post('/charges', { title, amount: Number(amount), dueDate, studentIds: ids });
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : '作れませんでした', 'error');
    }
  });
  return (
    <div className="card stack">
      <TextField label="請求の名前" hint="例: 発表会参加費" value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextField label="金額（税込・円）" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      <TextField label="期限" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <Loadable state={students.state} reload={students.reload} skeleton={<Skeleton lines={4} />}>
        {(list) => (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">請求する生徒</legend>
            <Button variant="ghost" onClick={() => setIds(ids.length === list.length ? [] : list.map((s) => s.id))}>
              {ids.length === list.length ? 'すべて外す' : 'すべて選ぶ'}
            </Button>
            {list.map((s) => (
              <Checkbox key={s.id} label={s.name} checked={ids.includes(s.id)} onChange={(e) => setIds(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))} />
            ))}
          </fieldset>
        )}
      </Loadable>
      <Button onClick={() => void save.run()} pending={save.pending} disabled={!title || !amount || ids.length === 0}>
        {ids.length}人に請求を作る
      </Button>
    </div>
  );
}

export function Pricing() {
  const toast = useToast();
  const { state, reload } = useLoad(() => Promise.all([api.get<Package[]>('/packages'), api.get<Course[]>('/courses')]), []);
  const [pkg, setPkg] = useState({ name: '', admissionFee: '', lessonCount: '', lessonsPrice: '' });
  const [course, setCourse] = useState({ name: '', lessonsPerMonth: '', amount: '' });
  const [revise, setRevise] = useState<{ courseId: string; amount: string; applyToExisting: boolean; effectiveMonth: string } | null>(null);
  const run = useAction(async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toast(message);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'error');
    }
  });
  const num = (s: string) => Number(s.replace(/\D/g, ''));
  return (
    <div className="stack-lg">
      <h1>料金</h1>
      <Notice>金額はすべて税込の総額で入力します。</Notice>
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={10} />}>
        {([packages, courses]) => (
          <>
            <section className="stack">
              <h2>入会セット</h2>
              <ul className="list">
                {packages.map((p) => (
                  <li key={p.id} className="spread">
                    <span>
                      <strong>{p.name}</strong>{!p.active && <span className="badge" style={{ marginLeft: 8 }}>非表示</span>}
                      <br />
                      <span className="small">
                        入会金 {fmtYen(p.admissionFee)}＋{p.lessonCount}回 {fmtYen(p.lessonsPrice)}＝{fmtYen(p.admissionFee + p.lessonsPrice)}
                      </span>
                    </span>
                    <Button variant="ghost" onClick={() => void run.run(() => api.patch(`/packages/${p.id}`, { ...p, active: !p.active }), p.active ? '入会画面に出さないようにしました' : '入会画面に出しました')}>
                      {p.active ? '非表示にする' : '表示する'}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="card stack">
                <h3>入会セットを追加</h3>
                <div className="grid-2">
                  <TextField label="名前" hint="例: 入会金＋4回" value={pkg.name} onChange={(e) => setPkg({ ...pkg, name: e.target.value })} />
                  <TextField label="入会金" inputMode="numeric" value={pkg.admissionFee} onChange={(e) => setPkg({ ...pkg, admissionFee: e.target.value })} />
                  <TextField label="含めるレッスン回数" inputMode="numeric" value={pkg.lessonCount} onChange={(e) => setPkg({ ...pkg, lessonCount: e.target.value })} />
                  <TextField label="レッスン分の価格" inputMode="numeric" value={pkg.lessonsPrice} onChange={(e) => setPkg({ ...pkg, lessonsPrice: e.target.value })} />
                </div>
                <Button
                  variant="secondary"
                  pending={run.pending}
                  disabled={!pkg.name}
                  onClick={() =>
                    void run.run(
                      () => api.post('/packages', { name: pkg.name, admissionFee: num(pkg.admissionFee), lessonCount: num(pkg.lessonCount), lessonsPrice: num(pkg.lessonsPrice) }),
                      '入会セットを追加しました',
                    )
                  }
                >
                  追加する
                </Button>
              </div>
            </section>
            <section className="stack">
              <h2>月額コース</h2>
              <ul className="list">
                {courses.map((c) => (
                  <li key={c.id} className="stack">
                    <div className="spread">
                      <span>
                        <strong>{c.name}</strong>　月{c.lessonsPerMonth}回・{c.amount !== null ? fmtYen(c.amount) : '—'}
                      </span>
                      <Button variant="secondary" onClick={() => setRevise({ courseId: c.id, amount: String(c.amount ?? ''), applyToExisting: false, effectiveMonth: '' })}>
                        料金を改定
                      </Button>
                    </div>
                    {revise?.courseId === c.id && (
                      <div className="card stack">
                        <TextField label="新しい月額（税込）" inputMode="numeric" value={revise.amount} onChange={(e) => setRevise({ ...revise, amount: e.target.value })} />
                        <Select label="適用する生徒" value={revise.applyToExisting ? 'all' : 'new'} onChange={(e) => setRevise({ ...revise, applyToExisting: e.target.value === 'all' })}>
                          <option value="new">新規の生徒だけ</option>
                          <option value="all">既存の生徒にも適用する</option>
                        </Select>
                        {revise.applyToExisting && (
                          <TextField label="適用する月" type="month" hint="この月の課金から新しい料金になります" value={revise.effectiveMonth} onChange={(e) => setRevise({ ...revise, effectiveMonth: e.target.value })} />
                        )}
                        <div className="row">
                          <Button
                            pending={run.pending}
                            onClick={() =>
                              void run.run(async () => {
                                await api.post(`/courses/${c.id}/price`, { amount: num(revise.amount), applyToExisting: revise.applyToExisting, effectiveMonth: revise.effectiveMonth || undefined });
                                setRevise(null);
                              }, '料金を改定しました')
                            }
                          >
                            改定する
                          </Button>
                          <Button variant="ghost" onClick={() => setRevise(null)}>
                            やめる
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="card stack">
                <h3>月額コースを追加</h3>
                <div className="grid-2">
                  <TextField label="名前" hint="例: 月4回コース" value={course.name} onChange={(e) => setCourse({ ...course, name: e.target.value })} />
                  <TextField label="月のレッスン回数" inputMode="numeric" value={course.lessonsPerMonth} onChange={(e) => setCourse({ ...course, lessonsPerMonth: e.target.value })} />
                  <TextField label="月額（税込）" inputMode="numeric" value={course.amount} onChange={(e) => setCourse({ ...course, amount: e.target.value })} />
                </div>
                <Button
                  variant="secondary"
                  pending={run.pending}
                  disabled={!course.name}
                  onClick={() => void run.run(() => api.post('/courses', { name: course.name, lessonsPerMonth: num(course.lessonsPerMonth), amount: num(course.amount) }), '月額コースを追加しました')}
                >
                  追加する
                </Button>
              </div>
            </section>
          </>
        )}
      </Loadable>
    </div>
  );
}
