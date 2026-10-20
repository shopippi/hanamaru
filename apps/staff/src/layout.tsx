import { NavLink, Outlet } from 'react-router-dom';
import { Button, OfflineBanner, useAction } from '@hanamaru/ui';
import { api } from './api.js';

const TABS = [
  { to: '/', label: '担当レッスン', end: true },
  { to: '/students', label: '担当生徒', end: false },
  { to: '/availability', label: '空き時間', end: false },
];

export function Layout() {
  const logout = useAction(async () => {
    await api.post('/auth/logout');
    location.assign('/login');
  });
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <a className="app-title" href="/">
            はなまる音楽教室 講師
          </a>
          <Button variant="ghost" onClick={() => void logout.run()} pending={logout.pending} pendingLabel="…">
            ログアウト
          </Button>
        </div>
      </header>
      <main className="app-main">
        <div className="stack-lg">
          <OfflineBanner />
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
  );
}
