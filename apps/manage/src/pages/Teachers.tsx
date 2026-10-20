import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AvailabilityEditor, Button, Empty, Loadable, Notice, Skeleton, TextField, Warning, fieldErrors, useAction, useLoad, useToast, type AvChange, type AvException, type AvResult, type AvRule } from '@hanamaru/ui';
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
    <div className="stack-lg">
      <div className="spread">
        <h1 style={{ margin: 0 }}>講師</h1>
        <Button onClick={() => setAdding(!adding)}>講師を登録</Button>
      </div>
      {adding && (
        <div className="card stack">
          {error && <Warning title={error} />}
          <TextField label="名前" value={form.name} error={errors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField label="メールアドレス" type="email" inputMode="email" value={form.email} error={errors.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <TextField
            label="プロフィールのキー"
            hint="講師プロフィールのデータファイルの slug（英小文字・数字・ハイフン）"
            value={form.profileSlug}
            error={errors.profileSlug}
            onChange={(e) => setForm({ ...form, profileSlug: e.target.value })}
          />
          <Button onClick={() => void add.run()} pending={add.pending}>
            登録して招待メールを送る
          </Button>
        </div>
      )}
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={5} />}>
        {(list) =>
          list.length === 0 ? (
            <Empty message="講師が登録されていません" action={<Button onClick={() => setAdding(true)}>講師を登録</Button>} />
          ) : (
            <ul className="list">
              {list.map((t) => (
                <li key={t.id} className="spread">
                  <div>
                    <strong>{t.name}</strong> {!t.active && <span className="badge">停止中</span>}
                    <br />
                    <span className="small muted">{t.email}</span>
                  </div>
                  <div className="row">
                    <Link className="btn btn-secondary" to={`/teachers/${t.id}/availability`}>
                      空き時間
                    </Link>
                    <Button variant="ghost" onClick={() => void toggle.run(t)}>
                      {t.active ? '停止する' : '再開する'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
    </div>
  );
}

export function TeacherAvailability() {
  const { id } = useParams();
  const { state, reload } = useLoad(() => Promise.all([api.get<LessonType[]>('/lesson-types'), api.get<Teacher[]>('/teachers')]), []);
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
      {([types, teachers]) => (
        <div className="stack">
          <h1>{teachers.find((t) => t.id === id)?.name}の空き時間</h1>
          <Notice>講師本人も講師の画面から設定できます。「体験専用」の枠は、設定で一般公開を ON にすると誰でも予約できます。</Notice>
          <AvailabilityEditor
            allowTrial
            lessonTypes={types}
            load={() => api.get<{ rules: AvRule[]; exceptions: AvException[] }>(`/teachers/${id}/availability`)}
            save={(change: AvChange, confirm: boolean) => api.post<AvResult>(`/teachers/${id}/availability`, { change, confirm })}
          />
        </div>
      )}
    </Loadable>
  );
}
