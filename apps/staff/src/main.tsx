import '@hanamaru/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { LoginPage, ResetRequestPage, SetPasswordPage, ToastProvider } from '@hanamaru/ui';
import { api } from './api.js';
import { Layout } from './layout.js';
import { Availability } from './pages/Availability.js';
import { Lessons } from './pages/Lessons.js';
import { Record } from './pages/Record.js';
import { StudentPage, Students } from './pages/Students.js';

// 講師の画面（staff.hanamarumusic.com）

function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return <LoginPage api={api} title="講師ログイン" onLoggedIn={() => navigate(params.get('next') ?? '/', { replace: true })} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/reset-password"
            element={new URLSearchParams(location.search).has('token') ? <SetPasswordPage api={api} mode="reset" /> : <ResetRequestPage api={api} captchaSiteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY} />}
          />
          <Route path="/invite" element={<SetPasswordPage api={api} mode="invite" />} />
          <Route element={<Layout />}>
            <Route index element={<Lessons />} />
            <Route path="/lessons/:id/record" element={<Record />} />
            <Route path="/students" element={<Students />} />
            <Route path="/students/:id" element={<StudentPage />} />
            <Route path="/availability" element={<Availability />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
