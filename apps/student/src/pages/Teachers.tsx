import { Empty, Loadable, Skeleton, useLoad } from '@hanamaru/ui';
import { api, type TeacherProfile } from '../api.js';
import { useStudent } from '../student-context.js';

// 担当講師のプロフィール（TC-05）

export function Teachers() {
  const { current } = useStudent();
  const { state, reload } = useLoad(() => api.get<TeacherProfile[]>(`/students/${current.id}/teachers`), [current.id]);
  return (
    <div className="stack">
      <h1>担当の講師</h1>
      <Loadable
        state={state}
        reload={reload}
        skeleton={
          <div className="card">
            <Skeleton lines={4} />
          </div>
        }
      >
        {(list) =>
          list.length === 0 ? (
            <Empty message="担当の講師がまだ決まっていません。教室にお問い合わせください。" />
          ) : (
            <div className="stack">
              {list.map((t) => (
                <article key={t.teacherId} className="card stack">
                  <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
                    {t.photo ? (
                      <img src={t.photo} alt="" width={88} height={88} style={{ borderRadius: '50%', objectFit: 'cover', filter: 'grayscale(1)' }} />
                    ) : (
                      <div aria-hidden="true" style={{ width: 88, height: 88, borderRadius: '50%', background: 'var(--c-bg-subtle)' }} />
                    )}
                    <div>
                      <h2 style={{ marginBottom: 4 }}>{t.name}</h2>
                      <p className="muted" style={{ margin: 0 }}>
                        {t.instruments.join('・')}
                      </p>
                    </div>
                  </div>
                  {t.career && (
                    <div>
                      <h3>経歴</h3>
                      <p>{t.career}</p>
                    </div>
                  )}
                  {t.message && (
                    <div>
                      <h3>ひとこと</h3>
                      <p>{t.message}</p>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )
        }
      </Loadable>
    </div>
  );
}
