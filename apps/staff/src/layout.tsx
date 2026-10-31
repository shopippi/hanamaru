import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { IconCalendar, IconClock, IconInbox, IconLogout, IconUser, IconUsers, LogoMark, OfflineBanner, useAction, useLoad } from '@hanamaru/ui';
import { api } from './api.js';

const TABS = [
  { to: '/', label: '担当レッスン', icon: IconCalendar, end: true },
  { to: '/students', label: '担当生徒', icon: IconUsers, end: false },
  { to: '/availability', label: '空き時間', icon: IconClock, end: false },
  { to: '/reviews', label: 'レビュー', icon: IconInbox, end: false },
];

/** レビューを確認したら、タブの印を付け直す */
export const REVIEWS_CHANGED = 'hanamaru:reviews-changed';

export function Layout() {
  const { pathname } = useLocation();
  // 未確認のレビューがあれば、タブに赤い印を付ける（RV-04）
  const unread = useLoad(() => api.get<{ unread: number }>('/reviews'), [pathname]);
  useEffect(() => {
    const onChange = () => unread.reload();
    window.addEventListener(REVIEWS_CHANGED, onChange);
    return () => window.removeEventListener(REVIEWS_CHANGED, onChange);
  }, [unread.reload]);
  const unreadCount = unread.data?.unread ?? 0;
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
          <Link className="btn btn-ghost btn-icon" to="/profile" aria-label="プロフィール" title="プロフィール" aria-current={pathname === '/profile' ? 'page' : undefined}>
            <IconUser />
          </Link>
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
                {to === '/reviews' && unreadCount > 0 && (
                  <>
                    <span className="tab-dot" aria-hidden="true" />
                    <span className="visually-hidden">（未確認 {unreadCount}件）</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
