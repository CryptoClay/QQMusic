import type { CSSProperties, ReactNode } from 'react';
import type { MeOut } from '../api/types';
import { Icon, type IconName } from './Icon';
import { Link, useRoute } from '../lib/router';
import { cx } from './ui';
import type { Tab } from './TabBar';

const primary: Array<{ id: Tab; to: string; label: string; icon: IconName }> = [
  { id: 'home', to: '/home', label: 'Главная', icon: 'home' },
  { id: 'search', to: '/search', label: 'Поиск', icon: 'search' },
  { id: 'library', to: '/library', label: 'Библиотека', icon: 'library' },
  { id: 'downloads', to: '/downloads', label: 'Загрузки', icon: 'download' },
];
const personal: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/liked', label: 'Понравившиеся', icon: 'heart' },
  { to: '/playlists', label: 'Плейлисты', icon: 'playlist' },
  { to: '/artists', label: 'Исполнители', icon: 'user' },
  { to: '/lib/albums', label: 'Альбомы', icon: 'disc' },
  { to: '/nextcloud', label: 'Nextcloud', icon: 'library' },
];

export function DesktopShell({ children, me, active }: { children: ReactNode; me: MeOut; active: Tab | null }) {
  return (
    <div className="min-h-dvh bg-bg text-fg" style={{ '--tabbar-h': '0px' } as CSSProperties}>
      <a href="#desktop-main" onClick={(event) => { event.preventDefault(); document.getElementById('desktop-main')?.focus(); }} className="sr-only fixed left-3 top-3 z-50 rounded-lg bg-[#ff984e] px-4 py-2 font-semibold text-black focus:not-sr-only">Перейти к содержимому</a>
      <DesktopSidebar active={active} />
      <div className="min-h-dvh min-w-0 pl-[238px]">
        <DesktopTopbar me={me} />
        {children}
      </div>
    </div>
  );
}

function DesktopSidebar({ active }: { active: Tab | null }) {
  const { path } = useRoute();
  const personalActive = personal.find((item) => path === item.to || (item.to === '/playlists' && path.startsWith('/playlist/')) || (item.to === '/artists' && path.startsWith('/lib/artist/')) || (item.to === '/lib/albums' && path.startsWith('/lib/album/')))?.to;
  return (
    <aside className="fixed inset-y-0 left-0 z-30 w-[238px] overflow-y-auto overscroll-contain border-r border-line bg-[#18191b] px-3 pb-6 pt-6" aria-label="Основная навигация">
      <Link to="/home" className="mb-9 flex items-center gap-3 px-3" aria-label="QQMusic — на главную">
        <img src="/icons/icon.svg" width={40} height={40} alt="" className="shrink-0 rounded-[13px]" />
        <span className="min-w-0"><strong className="block text-[22px] leading-6 tracking-tight">QQMusic</strong><small className="block text-[9px] font-semibold tracking-[.08em] text-muted">ВАША МУЗЫКА</small></span>
      </Link>
      <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Обзор</div>
      <nav className="space-y-1" aria-label="Разделы сервиса">
        {primary.map((item) => <DesktopNavItem key={item.id} {...item} active={active === item.id && !(item.id === 'library' && personalActive)} />)}
      </nav>
      <div className="mt-9 px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Моя музыка</div>
      <nav className="space-y-1" aria-label="Моя музыка">
        {personal.map((item) => <DesktopNavItem key={item.to} {...item} active={personalActive === item.to} />)}
      </nav>
      <div className="mt-9 border-t border-line pb-5 pt-5">
        <DesktopNavItem to="/more" label="Настройки и ещё" icon="more" active={active === 'more'} />
      </div>
    </aside>
  );
}

function DesktopNavItem({ to, label, icon, active }: { to: string; label: string; icon: IconName; active: boolean }) {
  return <Link to={to} aria-current={active ? 'page' : undefined} className={cx('group relative flex h-10 items-center gap-4 rounded-xl px-3 text-[15px] transition-colors', active ? 'bg-[#3e2b20] font-semibold text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
    {active && <span className="absolute left-0 top-2 h-6 w-1 rounded-r bg-[#ff984e]" />}
    <Icon name={icon} size={21} stroke={active ? 2.2 : 1.8} className={cx('shrink-0', active ? 'text-[#ff984e]' : 'text-muted group-hover:text-fg')} />
    <span className="truncate">{label}</span>
  </Link>;
}

function DesktopTopbar({ me }: { me: MeOut }) {
  const { path } = useRoute();
  return <header className="flex h-[96px] items-center justify-between gap-6 px-8">
    <Link to="/search" className={cx('flex h-12 min-w-0 w-full max-w-[390px] items-center gap-3 rounded-xl border border-line bg-raised px-4 text-sm text-muted transition hover:border-[#8b5b3d] hover:text-fg', path === '/search' && 'invisible')}><Icon name="search" size={21} className="shrink-0" /><span className="truncate">Треки, исполнители, альбомы</span></Link>
    <Link to="/more" title="Настройки аккаунта" aria-label={`Настройки аккаунта ${me.username}`} className="flex h-12 min-w-0 shrink-0 items-center gap-3 rounded-xl border border-line bg-raised px-3 text-sm text-muted transition hover:border-[#8b5b3d] hover:text-fg">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#95532e] font-semibold text-fg">{me.username.slice(0, 1).toUpperCase()}</span><span className="max-w-36 truncate">{me.username}</span><Icon name="down" size={17} />
    </Link>
  </header>;
}
