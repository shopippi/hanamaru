import { Empty, IconTeacher, Loadable, Skeleton, useLoad } from '@hanamaru/ui';
import { api, type TeacherProfile } from '../api.js';
import { TeacherReviews, type MyReviews } from '../reviews.js';
import { useStudent } from '../student-context.js';
import { TeacherCard } from '../teacher-card.js';

// 担当講師のプロフィール（TC-05）とレビュー（RV-01〜03）。プロフィールは押すと開く

export function Teachers() {
  const { current } = useStudent();
  const { state, reload } = useLoad(
    () => Promise.all([api.get<TeacherProfile[]>(`/students/${current.id}/teachers`), api.get<MyReviews>(`/students/${current.id}/reviews`)]),
    [current.id],
  );
  return (
    <div className="stack">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div className="page-header-text">
          <h1>担当の講師</h1>
          <p>名前を押すと、プロフィールとレビューの欄が開きます。</p>
        </div>
      </div>
      <Loadable
        state={state}
        reload={reload}
        skeleton={
          <div className="card">
            <Skeleton lines={3} />
          </div>
        }
      >
        {([list, reviews]) =>
          list.length === 0 ? (
            <Empty icon={<IconTeacher />} message="担当の講師がまだ決まっていません" text="教室にお問い合わせください。" />
          ) : (
            <div className="stack">
              {list.map((t) => (
                <TeacherCard key={t.teacherId} teacher={t} >
                  <TeacherReviews studentId={current.id} teacherId={t.teacherId} teacherName={t.name} data={reviews} onChanged={reload} />
                </TeacherCard>
              ))}
            </div>
          )
        }
      </Loadable>
    </div>
  );
}
