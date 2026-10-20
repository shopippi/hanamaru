import { Empty, IconTeacher, Loadable, Skeleton, useLoad } from '@hanamaru/ui';
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
            <Empty icon={<IconTeacher />} message="担当の講師がまだ決まっていません" text="教室にお問い合わせください。" />
          ) : (
            <div className="stack">
              {list.map((t) => (
                <article key={t.teacherId} className="panel profile">
                  <header className="profile-head">
                    {t.photo ? (
                      <img className="profile-photo" src={t.photo} alt="" width={72} height={72} />
                    ) : (
                      <span className="avatar avatar-lg" aria-hidden="true">
                        {(t.name.trim().split(/\s+/).pop() ?? t.name).slice(0, 1)}
                      </span>
                    )}
                    <div>
                      <h2>{t.name}</h2>
                      {t.instruments.length > 0 && (
                        <p className="row-tight" style={{ marginTop: 6 }}>
                          {t.instruments.map((i) => (
                            <span key={i} className="badge">
                              {i}
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                  </header>
                  {(t.career || t.message) && (
                    <div className="panel-body stack">
                      {t.message && <blockquote className="profile-quote">{t.message}</blockquote>}
                      {t.career && (
                        <div>
                          <h3 className="card-title">経歴</h3>
                          <p style={{ whiteSpace: 'pre-wrap' }}>{t.career}</p>
                        </div>
                      )}
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
