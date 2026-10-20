import { useEffect, useRef, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Button,
  IconBan,
  IconCalendar,
  IconChart,
  IconClose,
  IconDoor,
  IconHistory,
  IconLogout,
  IconMenu,
  IconPulse,
  IconReceipt,
  IconSettings,
  IconSparkle,
  IconTag,
  IconTeacher,
  IconUsers,
  IconYen,
  LogoMark,
  OfflineBanner,
  useAction,
} from '@hanamaru/ui';
import { api } from './api.js';

// 管理画面（manage.hanamarumusic.com）。手前に Cloudflare Access を置く（URL-02）
// パソコンでは左にメニューを常に出し、スマホでは左から引き出す

type Item = { to: string; label: string; icon: ComponentType<{ size?: number }>; end?: boolean };

const NAV: { title: string; items: Item[] }[] = [
  {
    title: '運用',
    items: [
      { to: '/', label: 'ダッシュボード', icon: IconChart, end: true },
      { to: '/calendar', label: '予約', icon: IconCalendar },
      { to: '/students', label: '生徒', icon: IconUsers },
      { to: '/teachers', label: '講師', icon: IconTeacher },
      { to: '/trials', label: '体験', icon: IconSparkle },
    ],
  },
  {
    title: 'お金',
    items: [
      { to: '/payments', label: '入金', icon: IconYen },
      { to: '/charges', label: '単発の請求', icon: IconReceipt },
      { to: '/pricing', label: '料金', icon: IconTag },
    ],
  },
  {
    title: '教室',
    items: [
      { to: '/school-hours', label: '受付日', icon: IconDoor },
      { to: '/closures', label: '休講', icon: IconBan },
      { to: '/settings', label: '設定', icon: IconSettings },
      { to: '/audit', label: '操作記録', icon: IconHistory },
      { to: '/system', label: 'システムの状態', icon: IconPulse },
    ],
  },
];

function Brand() {
  return (
    <a className="brand" href="/">
      <LogoMark size={26} />
      <span>
        はなまる音楽教室<span className="brand-sub">管理</span>
      </span>
    </a>
  );
}

function SideNav({ onLogout, pending }: { onLogout: () => void; pending: boolean }) {
  return (
    <>
      <Brand />
      <nav aria-label="管理メニュー">
        {NAV.map((g) => (
          <div key={g.title} className="nav-group">
            <p className="nav-group-title label-caps">{g.title}</p>
            <ul>
              {g.items.map(({ to, label, icon: Icon, end }) => (
                <li key={to}>
                  <NavLink className="nav-link" to={to} end={end}>
                    <Icon size={18} />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <Button variant="quiet" block onClick={onLogout} pending={pending} pendingLabel="ログアウト中…" className="nav-logout">
          <IconLogout size={18} />
          ログアウト
        </Button>
      </div>
    </>
  );
}

export function Layout() {
  const drawer = useRef<HTMLDialogElement>(null);
  const location = useLocation();
  const logout = useAction(async () => {
    await api.post('/auth/logout');
    window.location.assign('/login');
  });
  // ページを移ったら引き出しを閉じ、先頭へ戻す
  useEffect(() => {
    if (drawer.current?.open) drawer.current.close();
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <SideNav onLogout={() => void logout.run()} pending={logout.pending} />
      </aside>
      <div className="shell-main">
        <header className="appbar mobile-only">
          <div className="appbar-inner wide">
            <Brand />
            <button type="button" className="btn btn-ghost btn-icon" aria-label="メニューを開く" onClick={() => drawer.current?.showModal()}>
              <IconMenu />
            </button>
          </div>
        </header>
        <dialog ref={drawer} className="drawer" aria-label="管理メニュー">
          <div className="sidebar">
            <div className="spread">
              <span />
              <button type="button" className="btn btn-ghost btn-icon" aria-label="メニューを閉じる" onClick={() => drawer.current?.close()}>
                <IconClose />
              </button>
            </div>
            <SideNav onLogout={() => void logout.run()} pending={logout.pending} />
          </div>
        </dialog>
        <main className="shell-content">
          <div className="stack-lg">
            <OfflineBanner />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
