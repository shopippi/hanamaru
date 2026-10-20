import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, fieldErrors, type Api } from './api.js';
import { Button, Notice, TextField, Warning } from './components.js';
import { LogoMark } from './icons.js';

// ログイン・パスワード再設定・招待（3.1、ST-01）。3つのポータルで共通の画面

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; 'expired-callback'?: () => void; language?: string }): string;
      reset(id?: string): void;
    };
  }
}

/** フォームのボット対策（NF-06）。サイトキーがなければ（開発時）何も出さない */
export function Turnstile({ siteKey, onToken }: { siteKey: string | undefined; onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !ref.current) return;
    const el = ref.current;
    const render = () => window.turnstile?.render(el, { sitekey: siteKey, callback: onToken, 'expired-callback': () => onToken(''), language: 'ja' });
    if (window.turnstile) {
      render();
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [siteKey, onToken]);
  return siteKey ? <div ref={ref} /> : null;
}

/** ログインなどの1枚の画面。中央の枠に、教室のマークと見出しを置く */
export function AuthFrame({ title, description, children, links }: { title: string; description?: ReactNode; children: ReactNode; links?: ReactNode }) {
  return (
    <main className="auth">
      <a className="auth-brand" href="/">
        <LogoMark size={30} />
        はなまる音楽教室
      </a>
      <div className="auth-card">
        <h1>{title}</h1>
        {description && <p className="auth-description">{description}</p>}
        <div className="stack-lg">{children}</div>
      </div>
      {links && <div className="auth-links">{links}</div>}
    </main>
  );
}

export function LoginPage({
  api,
  title,
  onLoggedIn,
  footer,
}: {
  api: Api;
  title: string;
  onLoggedIn: (result: { mfa: 'none' | 'verify' | 'setup' }) => void;
  footer?: ReactNode;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onLoggedIn(await api.post<{ mfa: 'none' | 'verify' | 'setup' }>('/auth/login', { email, password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインできませんでした');
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthFrame
      title={title}
      links={
        <>
          <a href="/reset-password">パスワードを忘れた方</a>
          {footer}
        </>
      }
    >
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Warning title={error} />}
        <TextField
          label="メールアドレス"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="パスワード"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" block pending={pending} pendingLabel="ログインしています…">
          ログイン
        </Button>
      </form>
    </AuthFrame>
  );
}

export function ResetRequestPage({ api, captchaSiteKey }: { api: Api; captchaSiteKey?: string }) {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/password-reset', { email, captchaToken: token || undefined });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信できませんでした');
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <AuthFrame title="メールを確認してください">
        <p>登録されているメールアドレスであれば、パスワード再設定のリンクを送りました。メールのリンクから新しいパスワードを設定してください。</p>
        <p className="muted small">メールが届かない場合は、迷惑メールのフォルダもご確認ください。</p>
        <a className="btn btn-secondary btn-block" href="/login">
          ログイン画面へ
        </a>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="パスワードの再設定" description="登録したメールアドレスを入力してください。再設定のリンクをお送りします。" links={<a href="/login">ログイン画面へ戻る</a>}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Warning title={error} />}
        <TextField
          label="メールアドレス"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Turnstile siteKey={captchaSiteKey} onToken={setToken} />
        <Button type="submit" block pending={pending}>
          再設定のリンクを送る
        </Button>
      </form>
    </AuthFrame>
  );
}

/** 招待リンク・再設定リンクから開く画面。URL の token でパスワードを設定する */
export function SetPasswordPage({ api, mode }: { api: Api; mode: 'invite' | 'reset' }) {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    // 送信前に欄の下に理由を出す。入力した内容は消さない（UI-16）
    const local: Record<string, string> = {};
    if (password.length < 8) local.password = 'パスワードは8文字以上にしてください';
    if (password !== confirm) local.confirm = '確認用のパスワードが一致しません';
    setErrors(local);
    if (Object.keys(local).length) return;
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/password', { token, password });
      setDone(true);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : '設定できませんでした');
    } finally {
      setPending(false);
    }
  };

  const title = mode === 'invite' ? 'パスワードの設定' : '新しいパスワードの設定';
  if (done) {
    return (
      <AuthFrame title="設定しました">
        <p>新しいパスワードでログインしてください。</p>
        <a className="btn btn-primary btn-block" href="/login">
          ログイン画面へ
        </a>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={title}>
      <form className="stack" onSubmit={submit} noValidate>
        {mode === 'invite' && <Notice>ご登録ありがとうございます。ログインに使うパスワードを決めてください。</Notice>}
        {!token && <Warning title="リンクが正しくありません。メールのリンクをもう一度開いてください" />}
        {error && <Warning title={error} />}
        <TextField
          label="パスワード"
          hint="8文字以上"
          type="password"
          autoComplete="new-password"
          value={password}
          error={errors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label="パスワード（確認）"
          type="password"
          autoComplete="new-password"
          value={confirm}
          error={errors.confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button type="submit" block pending={pending} disabled={!token}>
          設定する
        </Button>
      </form>
    </AuthFrame>
  );
}
