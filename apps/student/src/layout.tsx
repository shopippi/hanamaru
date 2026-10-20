import { NavLink, Outlet } from 'react-router-dom';
import { IconCalendarPlus, IconHome, IconList, IconLogout, IconTeacher, LogoMark, OfflineBanner, useAction } from '@hanamaru/ui';
import { api } from './api.js';
import { InAppBrowserNotice } from './notices.js';
import { ChildSwitcher, StudentProvider, useStudent } from './student-context.js';

function Header() {
  const { current } = useStudent();
  const logout = useAction(async () => {
    await api.post('/auth/logout');
    location.assign('/login');
  });
  return (
    <header className="appbar">
      <div className="appbar-inner">
        <a className="brand" href="/">
          <LogoMark size={26} />
          <span>はなまる音楽教室</span>
        </a>
        <span className="appbar-student" aria-label="表示中の生徒">
          {current.name}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="ログアウト"
          title="ログアウト"
          onClick={() => void logout.run()}
          disabled={logout.pending}
        >
          <IconLogout />
        </button>
      </div>
    </header>
  );
}

const TABS = [
  { to: '/', label: 'ホーム', icon: IconHome, end: true },
  { to: '/book', label: '予約する', icon: IconCalendarPlus, end: false },
  { to: '/reservations', label: '予約一覧', icon: IconList, end: false },
  { to: '/teachers', label: '講師', icon: IconTeacher, end: false },
];

export function Layout() {
  return (
    <StudentProvider>
      <div className="app">
        <Header />
        <main className="app-main narrow">
          <div className="stack-lg">
            <OfflineBanner />
            <InAppBrowserNotice />
            <ChildSwitcher />
            <Outlet />
          </div>
        </main>
        <nav className="tabbar" aria-label="メインメニュー">
          <ul>
            {TABS.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink to={to} end={end}>
                  <Icon size={22} />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </StudentProvider>
  );
}
