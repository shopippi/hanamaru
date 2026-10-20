import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Loadable, Skeleton, TextArea, Warning, fieldErrors, fmtDateTime, useLoad, useToast } from '@hanamaru/ui';
import { api, type Lesson, type StudentDetail } from '../api.js';

// レッスン記録の入力（SR-04）。その回の内容と、どこまで進んだか

export function Record() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { state, reload } = useLoad(async () => {
    const lesson = await api.get<Lesson>(`/lessons/${id}`);
    if (!lesson.studentId) throw new Error('体験レッスンには記録を書けません');
    return [lesson, await api.get<StudentDetail>(`/students/${lesson.studentId}`)] as const;
  }, [id]);
  return (
    <div className="stack">
      <h1>レッスン記録</h1>
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={6} />}>
        {([lesson, s]) => (
          <RecordForm
            reservationId={id!}
            lesson={lesson}
            student={s}
            onSaved={() => {
              toast('記録を保存しました');
              navigate('/');
            }}
          />
        )}
      </Loadable>
    </div>
  );
}

function RecordForm({ reservationId, lesson, student, onSaved }: { reservationId: string; lesson: Lesson; student: StudentDetail; onSaved: () => void }) {
  const existing = student.lessonRecords.find((r) => r.reservationId === reservationId);
  const [content, setContent] = useState(existing?.content ?? '');
  const [progress, setProgress] = useState(existing?.progress ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const last = student.lessonRecords.filter((r) => r.reservationId !== reservationId).at(-1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!content.trim()) {
      setErrors({ content: 'レッスンの内容を入力してください' });
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.put(`/lessons/${reservationId}/record`, { content, progress });
      onSaved();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof Error ? err.message : '保存できませんでした');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p>
        <strong>{student.name}</strong>　{fmtDateTime(lesson.startsAt)}
      </p>
      {last && (
        <div className="notice small">
          <div>
            <strong>前回（{fmtDateTime(last.startsAt)}・{last.teacherName}）</strong>
            <br />
            {last.content}
            {last.progress && <><br />進み具合: {last.progress}</>}
          </div>
        </div>
      )}
      {error && <Warning title={error} />}
      <TextArea label="その回の内容" value={content} error={errors.content} onChange={(e) => setContent(e.target.value)} />
      <TextArea label="どこまで進んだか" value={progress} error={errors.progress} onChange={(e) => setProgress(e.target.value)} />
      <Button type="submit" block pending={pending}>
        保存する
      </Button>
    </form>
  );
}
