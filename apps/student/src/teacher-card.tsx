import { useId, useState, type ReactNode } from 'react';
import { IconChevronDown } from '@hanamaru/ui';
import type { TeacherProfile } from './api.js';

// 講師のプロフィール（TC-05）。名前と写真だけを出しておき、押すとメッセージと経歴が下へ滑らかに伸びる。
// 端末の「視差効果を減らす」がオンなら、動かさずに開く（UI-09 と同じ考え方）

const initial = (name: string) => (name.trim().split(/\s+/).pop() ?? name).slice(0, 1);

export function TeacherCard({
  teacher,
  defaultOpen = false,
  compact = false,
  children,
}: {
  teacher: TeacherProfile;
  defaultOpen?: boolean;
  /** ホームに出す小さな形 */
  compact?: boolean;
  /** 開いたときにプロフィールの下に出すもの（レビューなど） */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <article className={`panel accordion${compact ? ' compact' : ''}`} data-open={open || undefined}>
      <h2 className="accordion-heading">
        <button type="button" className="accordion-trigger" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          {teacher.photo ? (
            <img className="profile-photo" src={teacher.photo} alt="" width={compact ? 56 : 72} height={compact ? 56 : 72} />
          ) : (
            <span className="avatar avatar-lg" aria-hidden="true">
              {initial(teacher.name)}
            </span>
          )}
          <span className="accordion-title">
            <span className="accordion-name">{teacher.name}</span>
            {teacher.instruments.length > 0 && (
              <span className="row-tight">
                {teacher.instruments.map((i) => (
                  <span key={i} className="badge">
                    {i}
                  </span>
                ))}
              </span>
            )}
            <span className="accordion-hint small muted">{open ? '閉じる' : 'プロフィールを見る'}</span>
          </span>
          <IconChevronDown className="accordion-chevron" />
        </button>
      </h2>
      <div className="accordion-body" id={bodyId} role="region" aria-label={`${teacher.name}のプロフィール`} inert={!open}>
        <div className="accordion-inner">
          <div className="panel-body stack">
            {teacher.message && <blockquote className="profile-quote">{teacher.message}</blockquote>}
            {teacher.career && (
              <div>
                <h3 className="card-title">経歴</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{teacher.career}</p>
              </div>
            )}
            {children}
          </div>
        </div>
      </div>
    </article>
  );
}
