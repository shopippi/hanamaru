import { useState, type FormEvent } from 'react';
import { Button, Loadable, Notice, Skeleton, TextField, Turnstile, Warning, fieldErrors, useLoad, AuthFrame, IconCheckCircle } from '@hanamaru/ui';
import { api, TURNSTILE_SITE_KEY } from '../api.js';

// 自己登録（ST-02）と招待コードでの登録（ST-03）。OFF のときは登録画面を出さない

export function Register() {
  const { state, reload } = useLoad(() => api.get<{ enabled: boolean; inviteCodeRequired: boolean }>('/registration'), []);
  const [form, setForm] = useState({ email: '', password: '', guardianName: '', studentName: '', phone: '', inviteCode: '' });
  const [captchaToken, setCaptchaToken] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const local: Record<string, string> = {};
    if (!form.studentName.trim()) local.studentName = '生徒の名前を入力してください';
    if (!form.email.includes('@')) local.email = 'メールアドレスの形式が正しくありません';
    if (form.password.length < 8) local.password = 'パスワードは8文字以上にしてください';
    if (!form.phone.trim()) local.phone = '電話番号を入力してください';
    setErrors(local);
    if (Object.keys(local).length) return;
    setPending(true);
    setError(null);
    try {
      await api.post('/registration', { ...form, inviteCode: form.inviteCode || undefined, captchaToken });
      setDone(true);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof Error ? err.message : '登録できませんでした');
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthFrame title="新規登録" description="生徒（保護者）のアカウントを作ります。" links={<a href="/login">ログイン画面へ戻る</a>}>
        <Loadable state={state} reload={reload} skeleton={<Skeleton lines={6} />}>
          {(opt) =>
            !opt.enabled ? (
              <Notice>登録は教室で受け付けています。教室にお問い合わせください。</Notice>
            ) : done ? (
              <div className="stack">
                <Notice icon={<IconCheckCircle />}>登録しました。教室で確認したあと、予約できるようになります。</Notice>
                <a className="btn btn-primary btn-block" href="/login">
                  ログイン画面へ
                </a>
              </div>
            ) : (
              <form className="stack" onSubmit={submit} noValidate>
                {error && <Warning title={error} />}
                {opt.inviteCodeRequired && (
                  <TextField label="招待コード" hint="入会時にお渡ししたコード" autoCapitalize="characters" autoComplete="off" value={form.inviteCode} error={errors.inviteCode} onChange={set('inviteCode')} />
                )}
                <TextField label="生徒のお名前" autoComplete="name" value={form.studentName} error={errors.studentName} onChange={set('studentName')} />
                <TextField label="保護者のお名前" hint="生徒が未成年の場合" autoComplete="name" value={form.guardianName} error={errors.guardianName} onChange={set('guardianName')} />
                <TextField label="電話番号" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} error={errors.phone} onChange={set('phone')} />
                <TextField label="メールアドレス" hint="ログインに使います" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" value={form.email} error={errors.email} onChange={set('email')} />
                <TextField label="パスワード" hint="8文字以上" type="password" autoComplete="new-password" value={form.password} error={errors.password} onChange={set('password')} />
                <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setCaptchaToken} />
                <Button type="submit" block pending={pending}>
                  登録する
                </Button>
              </form>
            )
          }
        </Loadable>
    </AuthFrame>
  );
}
