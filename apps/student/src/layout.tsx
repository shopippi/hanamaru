import { NavLink, Outlet } from 'react-router-dom';
import { Button, OfflineBanner, useAction } from '@hanamaru/ui';
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
    <header className="app-header">
      <div className="app-header-inner">
        <a className="app-title" href="/">
          はなまる音楽教室
        </a>
        <span className="small muted" aria-label="表示中の生徒">
          {current.name}
        </span>
        <Button variant="ghost" onClick={() => void logout.run()} pending={logout.pending} pendingLabel="…">
          ログアウト
        </Button>
      </div>
    </header>
  );
}

const TABS = [
  { to: '/', label: 'ホーム', end: true },
  { to: '/book', label: '予約する', end: false },
  { to: '/reservations', label: '予約一覧', end: false },
  { to: '/teachers', label: '講師', end: false },
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
            {TABS.map((t) => (
              <li key={t.to}>
                <NavLink to={t.to} end={t.end}>
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </StudentProvider>
  );
}
