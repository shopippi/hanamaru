import '@hanamaru/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ResetRequestPage, SetPasswordPage, ToastProvider } from '@hanamaru/ui';
import { api } from './api.js';
import { Layout } from './layout.js';
import { Calendar } from './pages/Calendar.js';
import { Dashboard } from './pages/Dashboard.js';
import { Login } from './pages/Login.js';
import { Audit, Closures, SettingsPage, Trials } from './pages/Misc.js';
import { Charges, Payments, Pricing } from './pages/Money.js';
import { StudentDetail } from './pages/StudentDetail.js';
import { SchoolHours } from './pages/SchoolHours.js';
import { Students } from './pages/Students.js';
import { TeacherAvailability, TeacherDetail, Teachers } from './pages/Teachers.js';

// 管理者の画面（manage.hanamarumusic.com）。最初にダッシュボードを出す（3.10）

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={new URLSearchParams(location.search).has('token') ? <SetPasswordPage api={api} mode="reset" /> : <ResetRequestPage api={api} />} />
          <Route path="/invite" element={<SetPasswordPage api={api} mode="invite" />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/students" element={<Students />} />
            <Route path="/students/:id" element={<StudentDetail />} />
            <Route path="/teachers" element={<Teachers />} />
            <Route path="/teachers/:id" element={<TeacherDetail />} />
            <Route path="/teachers/:id/availability" element={<TeacherAvailability />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/charges" element={<Charges />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/trials" element={<Trials />} />
            <Route path="/school-hours" element={<SchoolHours />} />
            <Route path="/closures" element={<Closures />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/audit" element={<Audit />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
