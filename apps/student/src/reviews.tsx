import { useState } from 'react';
import { Button, ConfirmDialog, IconPlus, TextArea, fieldErrors, fmtDateTime, useAction, useToast } from '@hanamaru/ui';
import { api } from './api.js';

// 講師へのレビュー（RV-01〜03）。何件でも書け、自分のレビューは小さくまとめて出し、押すと全文を開く

export interface MyReview {
  id: string;
  teacherId: string | null;
  teacherName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
}
export interface MyReviews {
  maxLength: number;
  reviews: MyReview[];
}

function Editor({
  initial,
  maxLength,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: string;
  maxLength: number;
  submitLabel: string;
  pending: boolean;
  error?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [local, setLocal] = useState<string | undefined>();
  const submit = () => {
    // 送る前に欄の下に理由を出す。入力した内容は消さない（UI-16）
    if (!text.trim()) return setLocal('レビューを入力してください');
    if (text.trim().length > maxLength) return setLocal(`${maxLength}文字以内で入力してください`);
    setLocal(undefined);
    onSubmit(text);
  };
  return (
    <div className="stack-sm">
      <TextArea label="レビュー" hint="レッスンの感想や、先生へのメッセージ" value={text} error={local ?? error} onChange={(e) => setText(e.target.value)} />
      <p className="counter num" aria-live="polite">
        {text.trim().length} / {maxLength}文字
      </p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="quiet" onClick={onCancel} disabled={pending}>
          やめる
        </Button>
        <Button onClick={submit} pending={pending}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function ReviewItem({ review, studentId, maxLength, onChanged }: { review: MyReview; studentId: string; maxLength: number; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const save = useAction(async (body: string) => {
    try {
      await api.patch(`/students/${studentId}/reviews/${review.id}`, { body });
      toast('レビューを直しました');
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(fieldErrors(e).body ?? (e instanceof Error ? e.message : '保存できませんでした'));
    }
  });
  const remove = useAction(async () => {
    try {
      await api.del(`/students/${studentId}/reviews/${review.id}`);
      toast('レビューを消しました');
      setConfirming(false);
      onChanged();
    } catch (e) {
      setConfirming(false);
      toast(e instanceof Error ? e.message : '消せませんでした', 'error');
    }
  });
  if (editing) {
    return (
      <li className="review-item">
        <div className="panel-body">
          <Editor
            initial={review.body}
            maxLength={maxLength}
            submitLabel="保存する"
            pending={save.pending}
            error={error}
            onSubmit={(b) => void save.run(b)}
            onCancel={() => (setEditing(false), setError(undefined))}
          />
        </div>
      </li>
    );
  }
  return (
    <li className="review-item">
      <details>
        <summary>
          <span className="review-meta">
            <span className="num">{fmtDateTime(review.createdAt)}</span>
            {review.edited && <span className="badge badge-muted">編集済み</span>}
          </span>
          <span className="review-preview">{review.body}</span>
          <span className="review-more">
            <span className="more-open">全文を見る</span>
            <span className="more-close">閉じる</span>
          </span>
        </summary>
        <p className="review-full">{review.body}</p>
        <div className="review-actions">
          <Button variant="quiet" onClick={() => setEditing(true)}>
            編集
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            削除
          </Button>
        </div>
      </details>
      <ConfirmDialog
        open={confirming}
        title="このレビューを消しますか"
        confirmLabel="消す"
        cancelLabel="消さない"
        pending={remove.pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove.run()}
      >
        <p className="review-full" style={{ padding: 0 }}>
          {review.body}
        </p>
        <p className="small muted">消したレビューは元に戻せません。</p>
      </ConfirmDialog>
    </li>
  );
}

/** 講師ごとのレビューの欄。書く・自分のレビューを見る・直す・消す */
export function TeacherReviews({
  studentId,
  teacherId,
  teacherName,
  data,
  onChanged,
}: {
  studentId: string;
  teacherId: string;
  teacherName: string;
  data: MyReviews;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const mine = data.reviews.filter((r) => r.teacherId === teacherId);
  const post = useAction(async (body: string) => {
    try {
      await api.post(`/students/${studentId}/reviews`, { teacherId, body });
      toast('レビューを投稿しました');
      setWriting(false);
      onChanged();
    } catch (e) {
      setError(fieldErrors(e).body ?? (e instanceof Error ? e.message : '投稿できませんでした'));
    }
  });
  return (
    <section className="stack-sm" aria-label={`${teacherName}へのレビュー`}>
      <div className="spread">
        <h3 className="card-title">レビュー</h3>
        {!writing && (
          <Button variant="secondary" onClick={() => setWriting(true)}>
            <IconPlus size={18} />
            レビューを書く
          </Button>
        )}
      </div>
      {writing && (
        <Editor
          initial=""
          maxLength={data.maxLength}
          submitLabel="投稿する"
          pending={post.pending}
          error={error}
          onSubmit={(b) => void post.run(b)}
          onCancel={() => (setWriting(false), setError(undefined))}
        />
      )}
      {mine.length > 0 ? (
        <>
          <p className="small muted">あなたのレビュー（{mine.length}件）。先生だけが読めます。</p>
          <ul className="review-list">
            {mine.map((r) => (
              <ReviewItem key={r.id} review={r} studentId={studentId} maxLength={data.maxLength} onChanged={onChanged} />
            ))}
          </ul>
        </>
      ) : (
        !writing && <p className="small muted">レッスンの感想を先生に届けられます。書いたレビューは先生だけが読めます。</p>
      )}
    </section>
  );
}
