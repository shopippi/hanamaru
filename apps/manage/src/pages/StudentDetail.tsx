import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Empty,
  IconAlert,
  IconBook,
  IconHistory,
  IconReceipt,
  Loadable,
  PageHeader,
  Panel,
  Stat,
  METHOD_LABEL,
  Notice,
  STUDENT_STATUS_LABEL,
  Select,
  Skeleton,
  TextArea,
  TextField,
  fmtDate,
  fmtDateTime,
  fmtMonth,
  fmtYen,
  monthKey,
  useAction,
  Warning,
  useLoad,
  useToast,
  TableWrap,
} from '@hanamaru/ui';
import { api, type AuditEntry, useBillingOptions, type Course, type Package, type StudentStatus, type Teacher } from '../api.js';

// 生徒の詳細（4.1）: 基本情報、状態、管理用備考、講師用備考、レッスン記録、回数の履歴、入金記録

interface Detail {
  id: string;
  name: string;
  guardianName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: StudentStatus;
  approved: boolean;
  scheduledStatus: StudentStatus | null;
  scheduledStatusAt: string | null;
  courseId: string | null;
  billingMethod: string;
  /** カード払いなのにカードが未登録（PY-03） */
  needsCard: boolean;
  adminNote: string;
  teacherNote: string;
  accountEmail: string | null;
  teachers: { id: string; name: string }[];
  lessonRecords: {
    id: string;
    startsAt: string;
    teacherName: string;
    content: string;
    progress: string;
  }[];
  creditLedger: {
    id: string;
    month: string;
    delta: number;
    reason: string;
    note: string;
    createdAt: string;
  }[];
  payments: {
    id: string;
    kind: string;
    method: string;
    month: string | null;
    amount: number;
    status: string;
    paidAt: string | null;
  }[];
}

const REASON: Record<string, string> = {
  grant_enrollment: '入会セット',
  grant_monthly: '月額',
  consume: '予約',
  refund: '返却',
  expire: '失効',
  carryover: '繰越',
  adjust: '手動調整',
};
const PAY_STATUS: Record<string, string> = {
  pending: '未払い',
  succeeded: '入金済み',
  failed: '決済失敗',
  cancelled: '取消',
};
const KIND: Record<string, string> = {
  enrollment: '入会',
  monthly: '月謝',
  one_off: '単発',
};

export function StudentDetail() {
  const { id } = useParams();
  const { state, reload } = useLoad(
    () =>
      Promise.all([
        api.get<Detail>(`/students/${id}`),
        api.get<Teacher[]>('/teachers'),
        api.get<Course[]>('/courses'),
        api.get<Package[]>('/packages'),
        api.get<AuditEntry[]>(`/audit-logs?targetType=student&targetId=${id}`),
      ]),
    [id],
  );
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={12} />}>
      {([d, teachers, courses, packages, logs]) => (
        <div>
          <PageHeader
            back={{
              to: '/students',
              label: '生徒の一覧',
              as: ({ to, className, children }) => (
                <Link to={to} className={className}>
                  {children}
                </Link>
              ),
            }}
            title={d.name}
            description={
              <span className="row-tight">
                <span className={d.status === 'active' ? 'badge badge-dot' : 'badge'}>{STUDENT_STATUS_LABEL[d.status]}</span>
                {!d.approved && <span className="badge badge-strong">承認待ち</span>}
                {d.needsCard && <span className="badge badge-strong">カード未登録</span>}
                {d.scheduledStatus && d.scheduledStatusAt && (
                  <span className="badge badge-muted">
                    {fmtDate(d.scheduledStatusAt)}から
                    {STUDENT_STATUS_LABEL[d.scheduledStatus]}
                  </span>
                )}
              </span>
            }
          />
          <div className="stack-lg">
            {d.needsCard && <CardRequest studentId={d.id} />}
            <StatusSection d={d} onChanged={reload} />
            <div className="grid-2">
              <InfoSection d={d} courses={courses} onSaved={reload} />
              <div className="stack-lg">
                <TeachersSection d={d} teachers={teachers} onSaved={reload} />
                <NotesSection d={d} />
              </div>
            </div>
            <CreditsSection d={d} onChanged={reload} />
            <PaymentsSection d={d} packages={packages} onChanged={reload} />
            <Panel title="レッスン記録" flush>
              {d.lessonRecords.length === 0 ? (
                <Empty icon={<IconBook />} message="まだ記録はありません" />
              ) : (
                <ul className="list">
                  {[...d.lessonRecords].reverse().map((r) => (
                    <li key={r.id}>
                      <p>
                        <strong>{fmtDateTime(r.startsAt)}</strong> <span className="small muted">{r.teacherName}</span>
                      </p>
                      <p style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.content}</p>
                      {r.progress && <p className="small secondary">進み具合: {r.progress}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="操作記録" flush>
              {logs.length === 0 ? (
                <Empty icon={<IconHistory />} message="操作記録はありません" />
              ) : (
                <ul className="list small">
                  {logs.map((l) => (
                    <li key={l.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                      <span className="list-row-main">
                        <span className="list-title">{l.label}</span>
                        {l.summary && <span className="list-meta">{l.summary}</span>}
                      </span>
                      <span className="list-meta num nowrap" style={{ textAlign: 'right' }}>
                        {fmtDateTime(l.createdAt)}
                        <br />
                        {l.actorName}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </Loadable>
  );
}

function StatusSection({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const toast = useToast();
  const [target, setTarget] = useState<StudentStatus | null>(null);
  const change = useAction(async (status: StudentStatus) => {
    try {
      await api.post(`/students/${d.id}/status`, { status });
      toast(status === 'withdrawn' || status === 'suspended' ? '翌月1日から反映します' : '状態を変えました');
      setTarget(null);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更できませんでした', 'error');
    }
  });
  const approve = useAction(async () => {
    await api.post(`/students/${d.id}/approve`);
    toast('承認しました');
    onChanged();
  });
  return (
    <Panel title="状態">
      <div className="stack">
        {!d.approved && (
          <div className="notice warning" role="note">
            <span className="notice-icon" aria-hidden="true">
              <IconAlert />
            </span>
            <div className="notice-body spread">
              <p>
                <strong>この生徒は承認待ちです</strong>
              </p>
              <Button onClick={() => void approve.run()} pending={approve.pending}>
                登録を承認する
              </Button>
            </div>
          </div>
        )}
        <div className="row">
          {(['trial', 'enrolling', 'active', 'suspended', 'withdrawn'] as const)
            .filter((s) => s !== d.status)
            .map((s) => (
              <Button key={s} variant="secondary" onClick={() => setTarget(s)}>
                {STUDENT_STATUS_LABEL[s]}にする
              </Button>
            ))}
        </div>
        <ConfirmDialog
          open={!!target}
          title={`${STUDENT_STATUS_LABEL[target ?? 'active']}にしますか`}
          confirmLabel="変更する"
          pending={change.pending}
          onCancel={() => setTarget(null)}
          onConfirm={() => target && void change.run(target)}
        >
          {(target === 'withdrawn' || target === 'suspended') && (
            <p>
              翌月1日から反映します。今月末までは予約でき、返金はしません。翌月から課金を止めます。
              {target === 'withdrawn' ? '翌月になるとログインできなくなります。' : '休会中は予約できません。'}
            </p>
          )}
        </ConfirmDialog>
      </div>
    </Panel>
  );
}

function InfoSection({ d, courses, onSaved }: { d: Detail; courses: Course[]; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: d.name,
    guardianName: d.guardianName ?? '',
    phone: d.phone ?? '',
    email: d.email ?? '',
    address: d.address ?? '',
    courseId: d.courseId ?? '',
    billingMethod: d.billingMethod,
  });
  const billingOptions = useBillingOptions(d.billingMethod);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(async () => {
    try {
      await api.patch(`/students/${d.id}`, {
        ...form,
        courseId: form.courseId || null,
      });
      toast('保存しました');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'error');
    }
  });
  return (
    <Panel
      title="基本情報"
      footer={
        <Button onClick={() => void save.run()} pending={save.pending}>
          保存する
        </Button>
      }
    >
      <div className="stack">
        <p className="small muted">ログインメール: {d.accountEmail}</p>
        <TextField label="名前" value={form.name} onChange={set('name')} />
        <TextField label="保護者" value={form.guardianName} onChange={set('guardianName')} />
        <TextField label="電話番号" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} />
        <TextField label="メール" type="email" inputMode="email" value={form.email} onChange={set('email')} />
        <TextField label="住所" value={form.address} onChange={set('address')} />
        <Select label="月額コース" value={form.courseId} onChange={set('courseId')}>
          <option value="">未設定</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select label="支払い方法" value={form.billingMethod} onChange={set('billingMethod')}>
          {billingOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    </Panel>
  );
}

function TeachersSection({ d, teachers, onSaved }: { d: Detail; teachers: Teacher[]; onSaved: () => void }) {
  const toast = useToast();
  const [ids, setIds] = useState(d.teachers.map((t) => t.id));
  const save = useAction(async () => {
    await api.put(`/students/${d.id}/teachers`, { teacherIds: ids });
    toast('担当講師を保存しました');
    onSaved();
  });
  return (
    <Panel
      title="担当講師"
      footer={
        <Button variant="secondary" onClick={() => void save.run()} pending={save.pending}>
          担当講師を保存する
        </Button>
      }
    >
      <div className="stack-sm">
        <p className="small muted">担当を外しても既存の予約は残ります。新しい予約だけができなくなります。</p>
        {teachers.map((t) => (
          <Checkbox
            key={t.id}
            label={t.active ? t.name : `${t.name}（停止中）`}
            checked={ids.includes(t.id)}
            onChange={(e) => setIds(e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))}
          />
        ))}
      </div>
    </Panel>
  );
}

function NotesSection({ d }: { d: Detail }) {
  const toast = useToast();
  const [admin, setAdmin] = useState(d.adminNote);
  const [teacher, setTeacher] = useState(d.teacherNote);
  const save = useAction(async () => {
    await api.put(`/students/${d.id}/notes/admin`, { text: admin });
    await api.put(`/students/${d.id}/notes/teacher`, { text: teacher });
    toast('備考を保存しました');
  });
  return (
    <Panel
      title="備考"
      footer={
        <Button variant="secondary" onClick={() => void save.run()} pending={save.pending}>
          備考を保存する
        </Button>
      }
    >
      <div className="stack">
        <TextArea label="管理用備考" hint="講師には表示されません" value={admin} onChange={(e) => setAdmin(e.target.value)} />
        <TextArea label="講師用備考" hint="担当講師全員が読み書きできます" value={teacher} onChange={(e) => setTeacher(e.target.value)} />
      </div>
    </Panel>
  );
}

function CreditsSection({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const toast = useToast();
  const byMonth = new Map<string, number>();
  for (const l of d.creditLedger) byMonth.set(l.month, (byMonth.get(l.month) ?? 0) + l.delta);
  const [month, setMonth] = useState(monthKey(new Date()));
  const [delta, setDelta] = useState('1');
  const [note, setNote] = useState('');
  const adjust = useAction(async () => {
    try {
      await api.post(`/students/${d.id}/credits`, {
        month,
        delta: Number(delta),
        note,
      });
      toast('回数を調整しました');
      setNote('');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : '調整できませんでした', 'error');
    }
  });
  return (
    <section className="stack" aria-labelledby="credits-title">
      <div className="section-title">
        <h2 id="credits-title">回数</h2>
      </div>
      <div className="stat-grid">
        {[...byMonth]
          .sort()
          .reverse()
          .slice(0, 4)
          .map(([m, n]) => (
            <div key={m} className="card stat">
              <Stat label={`${fmtMonth(m)}の残り`} value={n} unit="回" />
            </div>
          ))}
      </div>
      <details>
        <summary>回数の履歴（{d.creditLedger.length}件）</summary>
        <TableWrap label="回数の履歴">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">日時</th>
                <th scope="col">対象月</th>
                <th scope="col">増減</th>
                <th scope="col">理由</th>
                <th scope="col">メモ</th>
              </tr>
            </thead>
            <tbody>
              {d.creditLedger.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDateTime(l.createdAt)}</td>
                  <td>{fmtMonth(l.month)}</td>
                  <td className="num">
                    <strong>{l.delta > 0 ? `+${l.delta}` : l.delta}</strong>
                  </td>
                  <td>{REASON[l.reason] ?? l.reason}</td>
                  <td>{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </details>
      <Panel
        title="回数の手動調整"
        footer={
          <Button variant="secondary" onClick={() => void adjust.run()} pending={adjust.pending} disabled={!note.trim() || !Number(delta)}>
            調整する
          </Button>
        }
      >
        <div className="stack">
          <div className="row">
            <input aria-label="対象月" type="month" className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} />
            <input aria-label="増減する回数" type="number" className="input" style={{ width: 96 }} value={delta} onChange={(e) => setDelta(e.target.value)} />
          </div>
          <TextField label="理由" hint="履歴に残ります（例: 振替レッスン分）" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Panel>
    </section>
  );
}

function PaymentsSection({ d, packages, onChanged }: { d: Detail; packages: Package[]; onChanged: () => void }) {
  const toast = useToast();
  const [month, setMonth] = useState(monthKey(new Date()));
  const [pkg, setPkg] = useState(packages[0]?.id ?? '');
  const cash = useAction(async () => {
    try {
      await api.post('/payments/cash', { studentId: d.id, month });
      toast('入金済みにしました。回数を付けました');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : '記録できませんでした', 'error');
    }
  });
  const enrollCash = useAction(async () => {
    try {
      await api.post(`/students/${d.id}/enrollment/cash`, { packageId: pkg });
      toast('入会セットを入金済みにしました');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : '記録できませんでした', 'error');
    }
  });
  return (
    <section className="stack" aria-labelledby="payments-title">
      <div className="section-title">
        <h2 id="payments-title">入金</h2>
      </div>
      {d.payments.length === 0 ? (
        <div className="panel">
          <Empty icon={<IconReceipt />} message="入金の記録はありません" />
        </div>
      ) : (
        <TableWrap label="入金の記録">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">種類</th>
                <th scope="col">対象月</th>
                <th scope="col">方法</th>
                <th scope="col">金額</th>
                <th scope="col">状態</th>
                <th scope="col">入金日時</th>
              </tr>
            </thead>
            <tbody>
              {d.payments.map((p) => (
                <tr key={p.id}>
                  <td>{KIND[p.kind]}</td>
                  <td>{p.month ? fmtMonth(p.month) : <span className="muted">—</span>}</td>
                  <td>{METHOD_LABEL[p.method]}</td>
                  <td className="num">{fmtYen(p.amount)}</td>
                  <td>
                    {p.status === 'failed' ? (
                      <span className="badge badge-strong">
                        <IconAlert size={14} />
                        {PAY_STATUS[p.status]}
                      </span>
                    ) : (
                      PAY_STATUS[p.status]
                    )}
                  </td>
                  <td>{p.paidAt ? fmtDateTime(p.paidAt) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div className="grid-2">
        <Panel
          title="月謝を現金で受け取った"
          footer={
            <Button variant="secondary" onClick={() => void cash.run()} pending={cash.pending}>
              入金済みにする
            </Button>
          }
        >
          <input aria-label="対象月" type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Panel>
        {d.status === 'enrolling' && (
          <Panel
            title="入会セットを現金で受け取った"
            footer={
              <Button variant="secondary" onClick={() => void enrollCash.run()} pending={enrollCash.pending} disabled={!pkg}>
                入金済みにする
              </Button>
            }
          >
            <Select label="入会セット" value={pkg} onChange={(e) => setPkg(e.target.value)}>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{fmtYen(p.admissionFee + p.lessonsPrice)}）
                </option>
              ))}
            </Select>
          </Panel>
        )}
      </div>
      <Notice>入金済みにすると、日時・金額・方法「現金」・操作した人が記録されます。</Notice>
    </section>
  );
}

/** カード払いなのにカードがない生徒に、登録のお願いを送る（PY-03） */
function CardRequest({ studentId }: { studentId: string }) {
  const toast = useToast();
  const send = useAction(async () => {
    try {
      await api.post(`/students/${studentId}/card-request`);
      toast('カード登録のお願いを送りました');
    } catch (e) {
      toast(e instanceof Error ? e.message : '送れませんでした', 'error');
    }
  });
  return (
    <Warning title="カードが登録されていません">
      <div className="stack-sm">
        <p>支払い方法はカードですが、まだカードが登録されていないため自動課金が始まっていません。生徒がトップ画面からカードを登録すると、翌月1日から自動課金になります。</p>
        <div>
          <Button variant="secondary" onClick={() => void send.run()} pending={send.pending}>
            カード登録のお願いを送る
          </Button>
        </div>
      </div>
    </Warning>
  );
}
