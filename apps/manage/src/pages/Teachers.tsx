import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AvailabilityEditor,
  Button,
  Empty,
  IconClock,
  IconPlus,
  IconTeacher,
  Loadable,
  IconChevronRight,
  IconUser,
  Notice,
  PageHeader,
  Panel,
  ProfileEditor,
  type PhotoUpload,
  type TeacherProfileData,
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
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const add = useAction(async () => {
    setError(null);
    try {
      const t = await api.post<{ id: string }>('/teachers', form);
      toast('講師を登録し、招待メールを送りました');
      // 続けてプロフィール・空き時間・担当生徒を入れてもらう
      navigate(`/teachers/${t.id}?new=1`);
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
        description="講師のアカウント、プロフィール（写真・担当の楽器・経歴）、空き時間を管理します。"
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
              <p className="small secondary">登録すると、講師に招待メールが届きます。続けてプロフィールと空き時間を入れます。</p>
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
                        <Link className="list-title" to={`/teachers/${t.id}`}>
                          {t.name}
                        </Link>{' '}
                        {!t.active && <span className="badge badge-strong">停止中</span>}
                        <span className="list-meta">
                          {t.instruments.length > 0 ? `${t.instruments.join('・')}　` : ''}
                          {t.email}
                        </span>
                      </span>
                      <span className="row">
                        <Link className="btn btn-secondary" to={`/teachers/${t.id}`}>
                          <IconUser size={18} />
                          プロフィール
                        </Link>
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

/** 講師の詳細: プロフィールと写真（TC-06）。登録した直後は「次にすること」を出す */
export function TeacherDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const isNew = params.get('new') === '1';
  const { state, reload } = useLoad(() => api.get<Teacher[]>('/teachers'), []);
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
      {(teachers) => {
        const t = teachers.find((x) => x.id === id);
        if (!t) return <Empty icon={<IconTeacher />} message="講師が見つかりません" />;
        return (
          <div>
            <PageHeader
              title={t.name}
              description={t.email}
              back={{
                to: '/teachers',
                label: '講師の一覧',
                as: ({ to, className, children }) => (
                  <Link to={to} className={className}>
                    {children}
                  </Link>
                ),
              }}
              actions={
                <Link className="btn btn-secondary" to={`/teachers/${t.id}/availability`}>
                  <IconClock size={18} />
                  空き時間
                </Link>
              }
            />
            <div className="stack-lg">
              {isNew && (
                <Panel title="次にすること">
                  <p className="small secondary">招待メールを送りました。講師がメールのリンクからパスワードを決めると、講師の画面にログインできます。</p>
                  <ol className="checklist">
                    <li>
                      <span className="grow">プロフィール（写真・担当の楽器・ひとこと・経歴）を入れる</span>
                      <span className="small muted">この下で入力</span>
                    </li>
                    <li>
                      <span className="grow">空き時間を入れる（講師本人も講師の画面で入れられます）</span>
                      <Link className="btn btn-quiet" to={`/teachers/${t.id}/availability`}>
                        空き時間へ
                        <IconChevronRight size={16} />
                      </Link>
                    </li>
                    <li>
                      <span className="grow">担当する生徒を決める（生徒の詳細の「担当講師」で選びます）</span>
                      <Link className="btn btn-quiet" to="/students">
                        生徒の一覧へ
                        <IconChevronRight size={16} />
                      </Link>
                    </li>
                  </ol>
                </Panel>
              )}
              <ProfileEditor
                description="生徒の画面の「講師」とホームに表示します。講師本人も講師の画面から編集できます。"
                load={() => api.get<TeacherProfileData>(`/teachers/${t.id}/profile`)}
                save={(input) => api.put<TeacherProfileData>(`/teachers/${t.id}/profile`, input)}
                savePhoto={(upload: PhotoUpload) => api.put<TeacherProfileData>(`/teachers/${t.id}/photo`, upload)}
                deletePhoto={() => api.del(`/teachers/${t.id}/photo`)}
              />
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}
