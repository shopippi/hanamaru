import { useState, type FormEvent } from 'react';
import { Button, ConfirmDialog, Notice, TextArea, TextField, Turnstile, Warning, fieldErrors, fmtDate, fmtTimeRange, useLoad } from '@hanamaru/ui';
import { api, TURNSTILE_SITE_KEY } from '../api.js';

// 体験レッスン（3.7）。ログインなしで使う。
// TR-01: 申込フォーム。TR-02: 体験専用の枠が公開されていれば、その場で予約できる

interface PublicSlot {
  teacherId: string;
  teacherName: string;
  lessonTypeId: string;
  lessonTypeName: string;
  startsAt: string;
  endsAt: string;
}

export function Trial() {
  const slots = useLoad(() => api.get<PublicSlot[]>('/trial/slots').catch(() => null), []);
  const [form, setForm] = useState({ name: '', guardianName: '', email: '', phone: '', instrument: '', preferredTimes: '', message: '' });
  const [captchaToken, setCaptchaToken] = useState('');
  const [picked, setPicked] = useState<PublicSlot | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<'request' | 'booked' | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const local: Record<string, string> = {};
    if (!form.name.trim()) local.name = 'お名前を入力してください';
    if (!form.email.includes('@')) local.email = 'メールアドレスの形式が正しくありません';
    setErrors(local);
    return Object.keys(local).length === 0;
  };

  const send = async (slot: PublicSlot | null) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (slot) {
        await api.post('/trial/reservations', { ...form, captchaToken, slot: { teacherId: slot.teacherId, lessonTypeId: slot.lessonTypeId, startsAt: slot.startsAt } });
        setDone('booked');
      } else {
        await api.post('/trial/requests', { ...form, captchaToken });
        setDone('request');
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof Error ? err.message : '送信できませんでした');
      slots.reload();
    } finally {
      setPending(false);
      setPicked(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (validate()) void send(null);
  };

  if (done) {
    return (
      <main className="app-main narrow">
        <div className="stack">
          <h1>{done === 'booked' ? 'ご予約が確定しました' : 'お申込を受け付けました'}</h1>
          <p>{done === 'booked' ? '確認のメールをお送りしました。当日お待ちしています。' : '日時を調整のうえ、教室からメールでご連絡します。'}</p>
        </div>
      </main>
    );
  }

  const available = slots.data ?? null;
  return (
    <main className="app-main narrow">
      <form className="stack-lg" onSubmit={submit} noValidate>
        <h1>体験レッスンのお申込</h1>
        {error && <Warning title={error} />}
        <div className="stack">
          <TextField label="お名前" autoComplete="name" value={form.name} error={errors.name} onChange={set('name')} />
          <TextField label="保護者のお名前" hint="お子さまの場合" autoComplete="name" value={form.guardianName} onChange={set('guardianName')} />
          <TextField label="メールアドレス" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={form.email} error={errors.email} onChange={set('email')} />
          <TextField label="電話番号" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} />
          <TextField label="習いたい楽器" value={form.instrument} onChange={set('instrument')} />
        </div>
        {available && available.length > 0 ? (
          <section className="stack">
            <h2>体験レッスンの枠から選ぶ</h2>
            <ul className="list">
              {available.map((s) => (
                <li key={s.teacherId + s.startsAt}>
                  <button type="button" className="choice" onClick={() => validate() && setPicked(s)}>
                    <span>
                      <strong>
                        {fmtDate(s.startsAt)} {fmtTimeRange(s.startsAt, s.endsAt)}
                      </strong>
                      <br />
                      <span className="small">
                        {s.teacherName}・{s.lessonTypeName}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted small">合う枠がなければ、下の欄にご希望の日時を書いてお申込ください。</p>
          </section>
        ) : (
          <Notice>ご希望の日時をお書きください。教室から日時をご連絡します。</Notice>
        )}
        <div className="stack">
          <TextArea label="ご希望の日時" hint="例: 平日の16時以降、土曜の午前" value={form.preferredTimes} onChange={set('preferredTimes')} />
          <TextArea label="ご質問など" value={form.message} onChange={set('message')} />
        </div>
        <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setCaptchaToken} />
        <Button type="submit" block pending={pending && !picked}>
          申し込む
        </Button>
      </form>
      <ConfirmDialog
        open={!!picked}
        title="この枠で体験レッスンを予約しますか"
        confirmLabel="予約する"
        pending={pending}
        onCancel={() => setPicked(null)}
        onConfirm={() => void send(picked)}
      >
        {picked && (
          <p>
            <strong>
              {fmtDate(picked.startsAt)} {fmtTimeRange(picked.startsAt, picked.endsAt)}
            </strong>
            <br />
            {picked.teacherName}・{picked.lessonTypeName}
          </p>
        )}
      </ConfirmDialog>
    </main>
  );
}
