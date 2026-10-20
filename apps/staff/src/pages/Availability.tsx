import { AvailabilityEditor, Loadable, PageHeader, Skeleton, useLoad, type AvChange, type AvResult } from '@hanamaru/ui';
import { api, type Exception, type LessonType, type Rule } from '../api.js';

// 自分の空き時間の設定（AV-01）。予約がある時間帯の変更は警告する（AV-02、AV-03）

export function Availability() {
  const { state, reload } = useLoad(() => api.get<LessonType[]>('/lesson-types'), []);
  return (
    <div>
      <PageHeader title="空き時間の設定" description="設定した時間が、担当生徒の予約画面に表示されます。" />
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
        {(types) => (
          <AvailabilityEditor
            lessonTypes={types}
            load={() => api.get<{ rules: Rule[]; exceptions: Exception[] }>('/availability')}
            save={(change: AvChange, confirm: boolean) => api.post<AvResult>('/availability', { change, confirm })}
          />
        )}
      </Loadable>
    </div>
  );
}
