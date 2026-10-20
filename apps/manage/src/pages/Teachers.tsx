import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AvailabilityEditor,
  Button,
  Empty,
  IconClock,
  IconPlus,
  IconTeacher,
  Loadable,
  Notice,
  PageHeader,
  Panel,
  Skeleton,
  TextField,
  Warning,
  fieldErrors,
  useAction,
  useLoad,
  useToast,
  type AvChange,
  type AvException,
  type AvResult,
  type AvCalendar,
  type AvDayInput,
  type AvRule,
} from '@hanamaru/ui';
import { api, type LessonType, type Teacher } from '../api.js';

// 講師の管理と、講師の空き時間（AV-01: 講師本人と管理者が設定する）

export function Teachers() {
  const toast = useToast();
  const { state, reload } = useLoad(() => api.get<Teacher[]>('/teachers'), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', profileSlug: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const add = useAction(async () => {
    setError(null);
    try {
      await api.post('/teachers', form);
      toast('講師を登録し、招待メールを送りました');
      setAdding(false);
      setForm({ name: '', email: '', profileSlug: '' });
      reload();
    } catch (e) {
      setErrors(fieldErrors(e));
      setError(e instanceof Error ? e.message : '登録できませんでした');
    }
  });
  const toggle = useAction(async (t: Teacher) => {
    await api.post(`/teachers/${t.id}/active`, { active: !t.active });
    toast(t.active ? 'ログインと予約を止めました' : '再開しました');
    reload();
  });
  return (
    <div>
      <PageHeader
        title="講師"
        description="講師のアカウントと、講師ごとの空き時間を管理します。"
        actions={
          <Button onClick={() => setAdding(!adding)} aria-expanded={adding}>
            <IconPlus size={18} />
            講師を登録
          </Button>
        }
      />
      <div className="stack-lg">
        {adding && (
          <Panel
            title="講師を登録"
            footer={
              <>
                <Button variant="secondary" onClick={() => setAdding(false)}>
                  やめる
                </Button>
                <Button onClick={() => void add.run()} pending={add.pending}>
                  登録して招待メールを送る
                </Button>
              </>
            }
          >
            <div className="stack">
              {error && <Warning title={error} />}
              <div className="grid-2">
                <TextField label="名前" value={form.name} error={errors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <TextField label="メールアドレス" type="email" inputMode="email" value={form.email} error={errors.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <TextField
                label="プロフィールのキー"
                hint="講師プロフィールのデータファイルの slug（英小文字・数字・ハイフン）"
                value={form.profileSlug}
                error={errors.profileSlug}
                onChange={(e) => setForm({ ...form, profileSlug: e.target.value })}
              />
            </div>
          </Panel>
        )}
        <Loadable state={state} reload={reload} skeleton={<Skeleton lines={5} />}>
          {(list) =>
            list.length === 0 ? (
              <div className="panel">
                <Empty icon={<IconTeacher />} message="講師が登録されていません" action={<Button onClick={() => setAdding(true)}>講師を登録</Button>} />
              </div>
            ) : (
              <div className="panel">
                <ul className="list">
                  {list.map((t) => (
                    <li key={t.id} className="list-row" style={{ flexWrap: 'wrap' }}>
                      <span className="avatar" aria-hidden="true">
                        {(t.name.trim().split(/\s+/).pop() ?? t.name).slice(0, 1)}
                      </span>
                      <span className="list-row-main">
                        <span className="list-title">
                          {t.name} {!t.active && <span className="badge badge-strong">停止中</span>}
                        </span>
                        <span className="list-meta">{t.email}</span>
                      </span>
                      <span className="row">
                        <Link className="btn btn-secondary" to={`/teachers/${t.id}/availability`}>
                          <IconClock size={18} />
                          空き時間
                        </Link>
                        <Button variant="quiet" onClick={() => void toggle.run(t)}>
                          {t.active ? '停止する' : '再開する'}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          }
        </Loadable>
      </div>
    </div>
  );
}

export function TeacherAvailability() {
  const { id } = useParams();
  const { state, reload } = useLoad(() => Promise.all([api.get<LessonType[]>('/lesson-types'), api.get<Teacher[]>('/teachers')]), []);
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
      {([types, teachers]) => (
        <div>
          <PageHeader
            title={`${teachers.find((t) => t.id === id)?.name}の空き時間`}
            back={{
              to: '/teachers',
              label: '講師の一覧',
              as: ({ to, className, children }) => (
                <Link to={to} className={className}>
                  {children}
                </Link>
              ),
            }}
          />
          <div className="stack-lg">
            <Notice>講師本人も講師の画面から設定できます。「体験専用」の枠は、設定で一般公開を ON にすると誰でも予約できます。</Notice>
            <AvailabilityEditor
              allowTrial
              lessonTypes={types}
              load={() => api.get<{ rules: AvRule[]; exceptions: AvException[] }>(`/teachers/${id}/availability`)}
              save={(change: AvChange, confirm: boolean) =>
                api.post<AvResult>(`/teachers/${id}/availability`, {
                  change,
                  confirm,
                })
              }
              loadCalendar={(month) => api.get<AvCalendar>(`/teachers/${id}/availability/calendar?month=${month}`)}
              saveDay={(input: AvDayInput, confirm: boolean) => api.put<AvResult>(`/teachers/${id}/availability/days`, { ...input, confirm })}
            />
          </div>
        </div>
      )}
    </Loadable>
  );
}
