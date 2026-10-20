import { NavLink, Outlet } from 'react-router-dom';
import { Button, OfflineBanner, useAction } from '@hanamaru/ui';
import { api } from './api.js';

// 管理画面（manage.hanamarumusic.com）。手前に Cloudflare Access を置く（URL-02）

const NAV = [
  { to: '/', label: 'ダッシュボード', end: true },
  { to: '/calendar', label: '予約' },
  { to: '/students', label: '生徒' },
  { to: '/teachers', label: '講師' },
  { to: '/payments', label: '入金' },
  { to: '/charges', label: '単発の請求' },
  { to: '/trials', label: '体験' },
  { to: '/pricing', label: '料金' },
  { to: '/closures', label: '休講' },
  { to: '/settings', label: '設定' },
  { to: '/audit', label: '操作記録' },
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
            はなまる音楽教室 管理
          </a>
          <Button variant="ghost" onClick={() => void logout.run()} pending={logout.pending} pendingLabel="…">
            ログアウト
          </Button>
        </div>
      </header>
      <main className="app-main" style={{ paddingBottom: 48 }}>
        <nav aria-label="管理メニュー">
          <ul className="sidenav">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.end}>
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="stack-lg">
          <OfflineBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
