import { NavLink, Outlet } from 'react-router-dom';
import { IconCalendar, IconClock, IconLogout, IconUsers, LogoMark, OfflineBanner, useAction } from '@hanamaru/ui';
import { api } from './api.js';

const TABS = [
  { to: '/', label: '担当レッスン', icon: IconCalendar, end: true },
  { to: '/students', label: '担当生徒', icon: IconUsers, end: false },
  { to: '/availability', label: '空き時間', icon: IconClock, end: false },
];

export function Layout() {
  const logout = useAction(async () => {
    await api.post('/auth/logout');
    location.assign('/login');
  });
  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar-inner">
          <a className="brand" href="/">
            <LogoMark size={26} />
            <span>
              はなまる音楽教室<span className="brand-sub">講師</span>
            </span>
          </a>
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
      <main className="app-main">
        <div className="stack-lg">
          <OfflineBanner />
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
  );
}
