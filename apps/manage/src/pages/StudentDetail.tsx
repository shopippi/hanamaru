import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Empty,
  Loadable,
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
  useLoad,
  useToast,
} from '@hanamaru/ui';
import { api, type Course, type Package, type StudentStatus, type Teacher } from '../api.js';

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
  adminNote: string;
  teacherNote: string;
  accountEmail: string | null;
  teachers: { id: string; name: string }[];
  lessonRecords: { id: string; startsAt: string; teacherName: string; content: string; progress: string }[];
  creditLedger: { id: string; month: string; delta: number; reason: string; note: string; createdAt: string }[];
  payments: { id: string; kind: string; method: string; month: string | null; amount: number; status: string; paidAt: string | null }[];
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
const PAY_STATUS: Record<string, string> = { pending: '未払い', succeeded: '入金済み', failed: '決済失敗', cancelled: '取消' };
const KIND: Record<string, string> = { enrollment: '入会', monthly: '月謝', one_off: '単発' };

export function StudentDetail() {
  const { id } = useParams();
  const { state, reload } = useLoad(
    () =>
      Promise.all([
        api.get<Detail>(`/students/${id}`),
        api.get<Teacher[]>('/teachers'),
        api.get<Course[]>('/courses'),
        api.get<Package[]>('/packages'),
        api.get<{ id: string; action: string; createdAt: string; details: Record<string, unknown> }[]>(`/audit-logs?targetType=student&targetId=${id}`),
      ]),
    [id],
  );
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={12} />}>
      {([d, teachers, courses, packages, logs]) => (
        <div className="stack-lg">
          <div>
            <h1 style={{ marginBottom: 4 }}>{d.name}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {STUDENT_STATUS_LABEL[d.status]}
              {!d.approved && '・承認待ち'}
              {d.scheduledStatus && d.scheduledStatusAt && `・${fmtDate(d.scheduledStatusAt)}から${STUDENT_STATUS_LABEL[d.scheduledStatus]}`}
            </p>
          </div>
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
          <section className="stack">
            <h2>レッスン記録</h2>
            {d.lessonRecords.length === 0 ? (
              <Empty message="まだ記録はありません" />
            ) : (
              <ul className="list">
                {[...d.lessonRecords].reverse().map((r) => (
                  <li key={r.id}>
                    <strong>{fmtDateTime(r.startsAt)}</strong> <span className="small muted">{r.teacherName}</span>
                    <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{r.content}</p>
                    {r.progress && <p className="small" style={{ margin: 0 }}>進み具合: {r.progress}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="stack">
            <h2>操作記録</h2>
            {logs.length === 0 ? (
              <Empty message="操作記録はありません" />
            ) : (
              <ul className="list small">
                {logs.map((l) => (
                  <li key={l.id}>
                    {fmtDateTime(l.createdAt)}　{l.action}
                  </li>
                ))}
              </ul>
            )}
          </section>
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
    <section className="card stack">
      <h2>状態</h2>
      {!d.approved && (
        <Button onClick={() => void approve.run()} pending={approve.pending}>
          登録を承認する
        </Button>
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
    </section>
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
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(async () => {
    try {
      await api.patch(`/students/${d.id}`, { ...form, courseId: form.courseId || null });
      toast('保存しました');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'error');
    }
  });
  return (
    <section className="card stack">
      <h2>基本情報</h2>
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
        {Object.entries(METHOD_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </Select>
      <Button onClick={() => void save.run()} pending={save.pending}>
        保存する
      </Button>
    </section>
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
    <section className="card stack">
      <h2>担当講師</h2>
      <p className="small muted">担当を外しても既存の予約は残ります。新しい予約だけができなくなります。</p>
      {teachers.map((t) => (
        <Checkbox key={t.id} label={t.active ? t.name : `${t.name}（停止中）`} checked={ids.includes(t.id)} onChange={(e) => setIds(e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))} />
      ))}
      <Button variant="secondary" onClick={() => void save.run()} pending={save.pending}>
        担当講師を保存する
      </Button>
    </section>
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
    <section className="card stack">
      <h2>備考</h2>
      <TextArea label="管理用備考" hint="講師には表示されません" value={admin} onChange={(e) => setAdmin(e.target.value)} />
      <TextArea label="講師用備考" hint="担当講師全員が読み書きできます" value={teacher} onChange={(e) => setTeacher(e.target.value)} />
      <Button variant="secondary" onClick={() => void save.run()} pending={save.pending}>
        備考を保存する
      </Button>
    </section>
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
      await api.post(`/students/${d.id}/credits`, { month, delta: Number(delta), note });
      toast('回数を調整しました');
      setNote('');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : '調整できませんでした', 'error');
    }
  });
  return (
    <section className="stack">
      <h2>回数</h2>
      <div className="grid">
        {[...byMonth].sort().reverse().slice(0, 4).map(([m, n]) => (
          <div key={m} className="card">
            <p className="card-title">{fmtMonth(m)}の残り</p>
            <p className="big-number num" style={{ margin: 0 }}>
              {n}
              <small>回</small>
            </p>
          </div>
        ))}
      </div>
      <details>
        <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>回数の履歴（{d.creditLedger.length}件）</summary>
        <div className="table-wrap">
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
                  <td className="num">{l.delta > 0 ? `+${l.delta}` : l.delta}</td>
                  <td>{REASON[l.reason] ?? l.reason}</td>
                  <td>{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <div className="card stack">
        <h3>回数の手動調整</h3>
        <div className="row">
          <input aria-label="対象月" type="month" className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} />
          <input aria-label="増減する回数" type="number" className="input" style={{ width: 96 }} value={delta} onChange={(e) => setDelta(e.target.value)} />
        </div>
        <TextField label="理由" hint="履歴に残ります（例: 振替レッスン分）" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="secondary" onClick={() => void adjust.run()} pending={adjust.pending} disabled={!note.trim() || !Number(delta)}>
          調整する
        </Button>
      </div>
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
    <section className="stack">
      <h2>入金</h2>
      {d.payments.length === 0 ? (
        <Empty message="入金の記録はありません" />
      ) : (
        <div className="table-wrap">
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
                  <td>{p.month ? fmtMonth(p.month) : '—'}</td>
                  <td>{METHOD_LABEL[p.method]}</td>
                  <td className="num">{fmtYen(p.amount)}</td>
                  <td>{p.status === 'failed' ? <strong>⚠ {PAY_STATUS[p.status]}</strong> : PAY_STATUS[p.status]}</td>
                  <td>{p.paidAt ? fmtDateTime(p.paidAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid-2">
        <div className="card stack">
          <h3>月謝を現金で受け取った</h3>
          <input aria-label="対象月" type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} />
          <Button variant="secondary" onClick={() => void cash.run()} pending={cash.pending}>
            入金済みにする
          </Button>
        </div>
        {d.status === 'enrolling' && (
          <div className="card stack">
            <h3>入会セットを現金で受け取った</h3>
            <Select label="入会セット" value={pkg} onChange={(e) => setPkg(e.target.value)}>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{fmtYen(p.admissionFee + p.lessonsPrice)}）
                </option>
              ))}
            </Select>
            <Button variant="secondary" onClick={() => void enrollCash.run()} pending={enrollCash.pending} disabled={!pkg}>
              入金済みにする
            </Button>
          </div>
        )}
      </div>
      <Notice>入金済みにすると、日時・金額・方法「現金」・操作した人が記録されます。</Notice>
    </section>
  );
}
