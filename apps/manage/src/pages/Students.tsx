import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Empty,
  Loadable,
  IconPlus,
  IconUpload,
  IconUsers,
  Notice,
  PageHeader,
  STUDENT_STATUS_LABEL,
  Select,
  Skeleton,
  TextArea,
  TextField,
  Warning,
  fieldErrors,
  fmtDate,
  useAction,
  useLoad,
  useToast,
} from '@hanamaru/ui';
import { api, useBillingOptions, type Course, type StudentRow, type Teacher } from '../api.js';

// 生徒の一覧・登録（ST-01、ST-02、DB-01 の移動先）

export function Students() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const pending = params.get('pending') === '1';
  const { state, reload } = useLoad(
    () => api.get<StudentRow[]>(`/students?${status ? `status=${status}` : ''}${pending ? '&pendingApproval=1' : ''}`),
    [status, pending],
  );
  const [mode, setMode] = useState<'list' | 'new' | 'csv'>('list');

  return (
    <div>
      <PageHeader
        title="生徒"
        description="在籍・休会・退会の状態と、連絡先を管理します。"
        actions={
          <>
            <Button variant="secondary" onClick={() => setMode(mode === 'csv' ? 'list' : 'csv')} aria-expanded={mode === 'csv'}>
              <IconUpload size={18} />
              CSVで登録
            </Button>
            <Button onClick={() => setMode(mode === 'new' ? 'list' : 'new')} aria-expanded={mode === 'new'}>
              <IconPlus size={18} />
              生徒を登録
            </Button>
          </>
        }
      />
      <div className="stack-lg">
        {mode === 'new' && <NewStudent onDone={() => (setMode('list'), reload())} />}
        {mode === 'csv' && <CsvImport onDone={() => (setMode('list'), reload())} />}
        <div className="tabs" role="group" aria-label="状態で絞り込む">
          {[['', 'すべて'], ...Object.entries(STUDENT_STATUS_LABEL)].map(([k, label]) => (
            <button key={k} type="button" aria-pressed={!pending && status === k} onClick={() => setParams(k ? { status: k } : {})}>
              {label}
            </button>
          ))}
          <button type="button" aria-pressed={pending} onClick={() => setParams({ pending: '1' })}>
            承認待ち
          </button>
        </div>
        <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
          {(list) =>
            list.length === 0 ? (
              <div className="panel">
                <Empty icon={<IconUsers />} message="該当する生徒はいません" text="絞り込みを変えるか、生徒を登録してください。" action={<Button onClick={() => setMode('new')}>生徒を登録</Button>} />
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="table-caption">{list.length}人</caption>
                  <thead>
                    <tr>
                      <th scope="col">名前</th>
                      <th scope="col">状態</th>
                      <th scope="col">保護者</th>
                      <th scope="col">ログインメール</th>
                      <th scope="col">電話</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <span className="person">
                            <span className="avatar avatar-sm" aria-hidden="true">
                              {(s.name.trim().split(/\s+/).pop() ?? s.name).slice(0, 1)}
                            </span>
                            <Link to={`/students/${s.id}`}>{s.name}</Link>
                          </span>
                        </td>
                        <td>
                          <span className="row-tight">
                            <span className={s.status === 'active' ? 'badge badge-dot' : 'badge'}>{STUDENT_STATUS_LABEL[s.status]}</span>
                            {!s.approved && <span className="badge badge-strong">承認待ち</span>}
                          </span>
                          {s.scheduledStatus && s.scheduledStatusAt && (
                            <div className="small muted">
                              {fmtDate(s.scheduledStatusAt)}から{STUDENT_STATUS_LABEL[s.scheduledStatus]}
                            </div>
                          )}
                        </td>
                        <td>{s.guardianName ?? <span className="muted">—</span>}</td>
                        <td>{s.accountEmail}</td>
                        <td className="num">{s.phone ?? <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Loadable>
      </div>
    </div>
  );
}

function NewStudent({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const refs = useLoad(() => Promise.all([api.get<Teacher[]>('/teachers'), api.get<Course[]>('/courses')]), []);
  const [form, setForm] = useState({ accountEmail: '', guardianName: '', name: '', phone: '', email: '', address: '', status: 'enrolling', courseId: '', billingMethod: 'card' });
  const [teacherIds, setTeacherIds] = useState<string[]>([]);
  const billingOptions = useBillingOptions();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(async () => {
    setError(null);
    try {
      const s = await api.post<{ id: string }>('/students', { ...form, courseId: form.courseId || null, teacherIds });
      toast('登録しました。招待メールを送りました');
      onDone();
      navigate(`/students/${s.id}`);
    } catch (e) {
      setErrors(fieldErrors(e));
      setError(e instanceof Error ? e.message : '登録できませんでした');
    }
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!form.name.trim()) local.name = '生徒の名前を入力してください';
    if (!form.accountEmail.includes('@')) local.accountEmail = 'メールアドレスの形式が正しくありません';
    setErrors(local);
    if (!Object.keys(local).length) void save.run();
  };
  return (
    <form className="panel" onSubmit={submit} noValidate>
      <div className="panel-header">
        <h2>生徒を登録</h2>
      </div>
      <div className="panel-body stack">
      <Notice>登録すると、ログインメールに招待メールが届きます。同じメールで登録すると、同じ保護者のお子さま（兄弟）として紐付きます。</Notice>
      {error && <Warning title={error} />}
      <div className="grid-2">
        <TextField label="生徒の名前" value={form.name} error={errors.name} onChange={set('name')} />
        <TextField label="保護者の名前" value={form.guardianName} onChange={set('guardianName')} />
        <TextField label="ログインメール（保護者または本人）" type="email" inputMode="email" value={form.accountEmail} error={errors.accountEmail} onChange={set('accountEmail')} />
        <TextField label="生徒のメール（任意）" type="email" inputMode="email" value={form.email} error={errors.email} onChange={set('email')} />
        <TextField label="電話番号" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} />
        <TextField label="住所" autoComplete="street-address" value={form.address} onChange={set('address')} />
        <Select label="状態" value={form.status} onChange={set('status')}>
          <option value="trial">体験</option>
          <option value="enrolling">入会手続き中</option>
          <option value="active">在籍中</option>
        </Select>
        <Select label="支払い方法" value={form.billingMethod} onChange={set('billingMethod')}>
          {billingOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Loadable state={refs.state} reload={refs.reload} skeleton={<Skeleton lines={3} />}>
        {([teachers, courses]) => (
          <div className="grid-2">
            <Select label="月額コース" value={form.courseId} onChange={set('courseId')}>
              <option value="">あとで決める</option>
              {courses.filter((c) => c.active).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">担当講師</legend>
              {teachers.filter((t) => t.active).map((t) => (
                <label key={t.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={teacherIds.includes(t.id)}
                    onChange={(e) => setTeacherIds(e.target.checked ? [...teacherIds, t.id] : teacherIds.filter((x) => x !== t.id))}
                  />
                  {t.name}
                </label>
              ))}
            </fieldset>
          </div>
        )}
      </Loadable>
      </div>
      <div className="panel-footer">
        <Button variant="secondary" onClick={onDone}>
          やめる
        </Button>
        <Button type="submit" pending={save.pending}>
          登録して招待メールを送る
        </Button>
      </div>
    </form>
  );
}

function CsvImport({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ created: number; errors: { line: number; message: string }[] } | null>(null);
  const run = useAction(async () => {
    try {
      const r = await api.post<{ created: number; errors: { line: number; message: string }[] }>('/students/import', { csv });
      setResult(r);
      if (r.errors.length === 0) {
        toast(`${r.created}人を登録し、招待メールを送りました`);
        onDone();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '登録できませんでした', 'error');
    }
  });
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>CSVで一括登録</h2>
      </div>
      <div className="panel-body stack">
      <p className="small secondary">
        1行目の見出し: <code>ログインメール,保護者名,生徒名,電話番号,生徒のメール,住所</code>
      </p>
      <p className="small secondary">
        続けて <code>月額コース,担当講師</code> の列を置くと、コースと担当講師もまとめて入ります（名前で書きます。担当講師が複数なら「、」で区切ります）。同じログインメールの行は、同じ家庭の兄弟として登録します。
      </p>
      <label className="btn btn-secondary" style={{ alignSelf: 'flex-start' }}>
        <IconUpload size={18} />
        ファイルを選ぶ
        <input
          type="file"
          accept=".csv,text/csv"
          className="visually-hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
        />
      </label>
      <TextArea label="CSVの内容" value={csv} onChange={(e) => setCsv(e.target.value)} />
      {result && result.errors.length > 0 && (
        <Warning title="誤りがあるため、登録していません">
          <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
            {result.errors.map((e) => (
              <li key={e.line}>
                {e.line}行目: {e.message}
              </li>
            ))}
          </ul>
        </Warning>
      )}
      </div>
      <div className="panel-footer">
        <Button onClick={() => void run.run()} pending={run.pending} disabled={!csv.trim()}>
          登録する
        </Button>
      </div>
    </div>
  );
}
