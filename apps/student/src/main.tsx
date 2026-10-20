import '@hanamaru/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { LoginPage, ResetRequestPage, SetPasswordPage, ToastProvider } from '@hanamaru/ui';
import { api, TURNSTILE_SITE_KEY } from './api.js';
import { Layout } from './layout.js';
import { Book } from './pages/Book.js';
import { Enroll } from './pages/Enroll.js';
import { Home } from './pages/Home.js';
import { Register } from './pages/Register.js';
import { Reservations } from './pages/Reservations.js';
import { Teachers } from './pages/Teachers.js';
import { Trial } from './pages/Trial.js';

function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (
    <LoginPage
      api={api}
      title="生徒ログイン"
      onLoggedIn={() => navigate(params.get('next') ?? '/', { replace: true })}
      footer={
        <div className="stack small">
          <p>
            <a href="/register">はじめての方（新規登録）</a>
          </p>
          <p>
            <a href="/trial">体験レッスンのお申込</a>
          </p>
        </div>
      }
    />
  );
}

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={new URLSearchParams(location.search).has('token') ? <SetPasswordPage api={api} mode="reset" /> : <ResetRequestPage api={api} captchaSiteKey={TURNSTILE_SITE_KEY} />} />
          <Route path="/invite" element={<SetPasswordPage api={api} mode="invite" />} />
          <Route path="/register" element={<Register />} />
          <Route path="/trial" element={<Trial />} />
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="/book" element={<Book />} />
            <Route path="/reservations" element={<Reservations />} />
            <Route path="/teachers" element={<Teachers />} />
            <Route path="/enroll" element={<Enroll />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// ホーム画面アプリ（4.5）。新しい版が公開されたら、次に開いたときに自動で切り替える（PW-05）。
// 入力の途中で画面が変わらないよう、アプリが裏に回ってから戻ってきたときに読み込み直す
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let updated = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    updated = true;
  });
  void navigator.serviceWorker.register('/sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (updated) location.reload();
      else void reg.update();
    });
  });
}
