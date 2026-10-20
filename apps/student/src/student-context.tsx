import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Loadable, Skeleton, useLoad } from '@hanamaru/ui';
import { api, type StudentSummary } from './api.js';

// 保護者アカウントの子どもの切り替え（ST-04）。予約・回数・支払いは子どもごとに分かれる

const KEY = 'hanamaru.studentId';

interface Ctx {
  students: StudentSummary[];
  current: StudentSummary;
  select: (id: string) => void;
}

const StudentContext = createContext<Ctx | null>(null);

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function StudentProvider({ children }: { children: ReactNode }) {
  const { state, reload } = useLoad(() => api.get<StudentSummary[]>('/students'), []);
  const [selected, setSelected] = useState<string | null>(remembered);
  useEffect(() => {
    try {
      if (selected) localStorage.setItem(KEY, selected);
    } catch {
      // 保存できなくても動く
    }
  }, [selected]);
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton block />}>
      {(students) => {
        if (students.length === 0) return <p>生徒の登録がありません。教室にお問い合わせください。</p>;
        const current = students.find((s) => s.id === selected) ?? students[0]!;
        return <StudentContext.Provider value={{ students, current, select: setSelected }}>{children}</StudentContext.Provider>;
      }}
    </Loadable>
  );
}

export function useStudent(): Ctx {
  const ctx = useContext(StudentContext);
  if (!ctx) throw new Error('StudentProvider is missing');
  return ctx;
}

/** 名前の頭文字（姓と名の間に空白があれば名の1文字目） */
export const initial = (name: string) => (name.trim().split(/\s+/).pop() ?? name).slice(0, 1);

export function ChildSwitcher() {
  const { students, current, select } = useStudent();
  if (students.length < 2) return null;
  return (
    <div className="child-switcher" role="group" aria-label="お子さまの切り替え">
      {students.map((s) => (
        <button key={s.id} type="button" className="child-chip" aria-pressed={s.id === current.id} onClick={() => select(s.id)}>
          <span className="avatar" aria-hidden="true">
            {initial(s.name)}
          </span>
          {s.name}
        </button>
      ))}
    </div>
  );
}
