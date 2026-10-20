import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, LoginPage, Notice, TextField, Warning } from '@hanamaru/ui';
import { api } from '../api.js';

// 管理者のログイン。二段階認証（AU-06）: 初回は認証アプリの登録、2回目以降は6桁の確認コード

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState<'password' | 'verify' | 'setup'>(params.get('step') === 'mfa' ? 'verify' : 'password');
  const done = () => navigate(params.get('next') ?? '/', { replace: true });
  if (step === 'password') {
    return <LoginPage api={api} title="管理画面ログイン" onLoggedIn={(r) => (r.mfa === 'none' ? done() : setStep(r.mfa))} />;
  }
  return <Mfa setup={step === 'setup'} onDone={done} />;
}

function Mfa({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const start = async () => {
    setPending(true);
    try {
      setSecret(await api.post<{ secret: string; uri: string }>('/auth/mfa/setup'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '開始できませんでした');
    } finally {
      setPending(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/mfa/verify', { code });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '確認できませんでした');
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="app-main narrow">
      <form className="stack-lg" onSubmit={submit} noValidate>
        <h1>二段階認証</h1>
        {setup && !secret && (
          <div className="stack">
            <Notice>管理画面では、パスワードに加えて認証アプリ（Google Authenticator など）の確認コードを使います。最初に認証アプリを登録してください。</Notice>
            <Button block onClick={() => void start()} pending={pending}>
              認証アプリを登録する
            </Button>
          </div>
        )}
        {setup && secret && (
          <div className="stack">
            <p>認証アプリで「セットアップキーを入力」を選び、次のキーを入力してください。スマホでこの画面を開いている場合は、下のリンクから登録できます。</p>
            <p className="card num" style={{ fontSize: 20, letterSpacing: 2, wordBreak: 'break-all' }}>
              {secret.secret.replace(/(.{4})/g, '$1 ').trim()}
            </p>
            <a className="btn btn-secondary btn-block" href={secret.uri}>
              認証アプリで開く
            </a>
          </div>
        )}
        {(!setup || secret) && (
          <div className="stack">
            {error && <Warning title={error} />}
            <TextField
              label="確認コード（6桁）"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button type="submit" block pending={pending} disabled={code.length !== 6}>
              確認する
            </Button>
          </div>
        )}
      </form>
    </main>
  );
}
