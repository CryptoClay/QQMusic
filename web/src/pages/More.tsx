import { clientStorage } from '../lib/storage';
import { useEffect, useState, type ReactNode } from 'react';
import { request } from '../api/client';
import { useDesktop } from '../lib/desktop';
import { STANDALONE } from '../lib/embedded';
import { useSession } from '../lib/session';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader, cx } from '../components/ui';
import { notifyPermission, requestNotifyPermission, type NotifyPermission } from '../lib/notify';
import { Link } from '../lib/router';
import { setSmartEnabled, useSmartEnabled } from '../lib/smartShuffle';
import { confirmDialog, toast } from '../lib/ui';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// beforeinstallprompt fires early, possibly before this page mounts: keep it globally.
let deferredInstall: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e as InstallPromptEvent;
});

export function MorePage() {
  const { me, logout } = useSession();
  const [perm, setPerm] = useState<NotifyPermission>(notifyPermission);
  const [canInstall, setCanInstall] = useState(!!deferredInstall);
  const smart = useSmartEnabled();
  const desktop = useDesktop();
  const [warm, setWarm] = useState(() => { try { return clientStorage.getItem('qqmusic-warm') !== 'off'; } catch { return true; } });
  const toggleWarm = () => { const next=!warm; setWarm(next); try {clientStorage.setItem('qqmusic-warm',next?'on':'off');} catch {} if(!next)void request('POST','/api/listen/prepare',{json:{refs:[]}}).catch(()=>{}); };
  const standalone = window.matchMedia('(display-mode: standalone)').matches;

  useEffect(() => {
    const on = () => setCanInstall(!!deferredInstall);
    window.addEventListener('beforeinstallprompt', on);
    const installed = () => { deferredInstall = null; setCanInstall(false); };
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', on);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  const enableNotifications = async () => {
    const p = await requestNotifyPermission();
    setPerm(p);
    if (p === 'granted') toast('Уведомления включены', 'success');
    else if (p === 'denied') toast('Уведомления запрещены. Разрешите их в настройках сайта в браузере.', 'error');
  };

  const install = async () => {
    if (!deferredInstall) return;
    await deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => undefined);
    deferredInstall = null;
    setCanInstall(false);
  };

  const doLogout = async () => {
    if (await confirmDialog({ title: 'Выйти из аккаунта?', okLabel: 'Выйти' })) await logout();
  };

  const permText: Record<NotifyPermission, string> = {
    granted: 'Включены',
    denied: 'Запрещены в настройках браузера',
    default: 'Нажмите, чтобы включить',
    unsupported: 'Не поддерживаются этим браузером',
  };

  if (desktop) return (
    <div className="px-6 pb-10 pt-7 xl:px-8">
      <header><h1 className="text-3xl font-bold tracking-tight">Настройки</h1><p className="mt-1.5 text-sm text-muted">Аккаунт, воспроизведение и управление сервисом</p></header>
      <div className="mt-8 grid max-w-5xl gap-6 min-[1280px]:grid-cols-2">
        <SettingsGroup title="Аккаунт">
          <li className="flex min-h-16 items-center gap-4 border-b border-line/60 px-4 py-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent font-bold uppercase text-on-accent">{me.username.slice(0, 1)}</span>
            <span className="min-w-0"><span className="block truncate font-semibold" title={me.username}>{me.username}</span><span className="block break-all text-sm text-muted">{[me.is_admin ? 'Администратор' : 'Пользователь', me.email, me.google_email && `Google: ${me.google_email}`].filter(Boolean).join(' · ')}</span></span>
          </li>
          <Item icon="logout" title="Выйти" onClick={doLogout} danger />
        </SettingsGroup>
        <SettingsGroup title="Воспроизведение и уведомления">
          <Item icon="download" title="Подготовка следующих треков" sub="До двух записей, до 64 MiB за очередь подготовки; отключается при экономии трафика" onClick={toggleWarm} right={<Switch on={warm} />} />
          <Item icon="refresh" to="/sources" title="Состояние источников" sub="Доступность поиска, аудио и авторизации" />
          <Item icon="volume" to="/music-settings" title="Музыка и звук" sub="Версии треков, радио, эквалайзер и переходы" />
          <Item icon="note" to="/notes" title="Мои заметки и метки" sub="Личные подборки и заметки о музыке" />
          <Item icon="wave" to="/recap" title="Мои музыкальные итоги" sub="Любимые исполнители и открытия месяца" />
          <Item icon="shuffleSmart" title="Умное перемешивание" sub="Добавляет рекомендации в плейлистах и избранном" onClick={() => setSmartEnabled(!smart)} right={<Switch on={smart} />} />
          <Item icon="bell" title="Уведомления" sub={permText[perm]} onClick={perm === 'default' ? enableNotifications : undefined} right={perm === 'granted' ? <Icon name="check" size={20} className="text-accent" /> : undefined} />
        </SettingsGroup>
        <SettingsGroup title="Музыка и устройства">
          <Item icon="upload" to="/upload" title="Загрузить файлы" sub="Добавить аудиофайлы в библиотеку" />
          <Item icon="library" to="/nextcloud" title="Nextcloud" sub="Личная музыка из вашего облака" />
          <Item icon="transfer" to="/import" title="Перенести музыку" sub="Из Яндекс Музыки: избранное, плейлисты и альбомы" />
          <Item icon="install" href="/app/latest.apk" title="Приложение для Android" sub="Офлайн, плеер в шторке, тот же аккаунт" />
          {canInstall && !standalone && <Item icon="install" title="Установить приложение" sub="На домашний экран" onClick={install} />}
        </SettingsGroup>
        {(me.is_admin || me.public_music_url) && <SettingsGroup title="Сервис">
          {me.is_admin && <Item icon="user" to="/admin" title="Пользователи и приглашения" sub="Пользователи, песни и коды приглашений" />}
          {me.public_music_url && <Item icon="external" href={me.public_music_url} title="Navidrome" sub="Веб-интерфейс библиотеки" />}
        </SettingsGroup>}
      </div>
      <p className="mt-8 text-sm text-muted">QQMusic · музыкальный сервис</p>
    </div>
  );

  return (
    <div>
      <PageHeader title="Ещё" />
      <div className="mx-4 mb-4 flex items-center gap-3 rounded-xl bg-surface p-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-lg font-bold uppercase text-on-accent">{me.username.slice(0, 1)}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{me.username}</div>
          <div className="truncate text-xs text-muted">
            {me.is_admin ? 'Администратор' : 'Пользователь'}
            {me.email ? ` · ${me.email}` : ''}
            {me.google_email ? ` · Google: ${me.google_email}` : ''}
          </div>
        </div>
      </div>

      <ul className="mx-4 overflow-hidden rounded-xl bg-surface">
        <Item icon="download" title="Подготовка следующих треков" sub="До двух записей; учитывает экономию трафика" onClick={toggleWarm} right={<Switch on={warm} />} />
        <Item icon="refresh" to="/sources" title="Состояние источников" sub="Доступность поиска и аудио" />
        <Item icon="volume" to="/music-settings" title="Музыка и звук" sub="Версии, радио, эквалайзер и переходы" />
        <Item icon="note" to="/notes" title="Мои заметки и метки" sub="Только для вашего аккаунта" />
        <Item icon="wave" to="/recap" title="Мои музыкальные итоги" sub="Ваш месяц в музыке" />
        {STANDALONE && (
          <Item
            icon="shuffleSmart"
            title="Умное перемешивание в режимах"
            sub="Кнопка перемешивания в плейлисте и «Понравившихся» добавляет рекомендации"
            onClick={() => setSmartEnabled(!smart)}
            right={<Switch on={smart} />}
          />
        )}
        <Item icon="upload" to="/upload" title="Загрузить файлы" sub="Добавить свои аудиофайлы в библиотеку" />
        <Item icon="library" to="/nextcloud" title="Nextcloud" sub="Личная музыка из вашего облака" />
        <Item icon="playlist" to="/playlists" title="Плейлисты" sub="Ваши плейлисты в Navidrome" />
        <Item icon="transfer" to="/import" title="Перенести музыку" sub="Из Яндекс Музыки: ♥, плейлисты, альбомы" />
        {me.is_admin && <Item icon="user" to="/admin" title="Пользователи и приглашения" sub="Пользователи, песни и коды приглашений" />}
        {/* the player is here: in the browser, and the app's own on Android */}
        <Item icon="install" href="/app/latest.apk" title="Приложение для Android" sub="Офлайн, плеер в шторке, тот же аккаунт" />
        {me.public_music_url && <Item icon="external" href={me.public_music_url} title="Navidrome" sub="Веб-интерфейс библиотеки" />}
        <Item
          icon="bell"
          title="Уведомления"
          sub={permText[perm]}
          onClick={perm === 'default' ? enableNotifications : undefined}
          right={perm === 'granted' ? <Icon name="check" size={20} className="text-accent" /> : undefined}
        />
        {canInstall && !standalone && <Item icon="install" title="Установить приложение" sub="На домашний экран, с «Поделиться» → QQMusic" onClick={install} />}
        <Item icon="logout" title="Выйти" onClick={doLogout} danger />
      </ul>

      <p className="px-6 py-6 text-center text-xs text-dim">QQMusic · музыкальный сервис</p>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0"><h2 className="mb-3 text-lg font-semibold">{title}</h2><ul className="overflow-hidden rounded-xl border border-line bg-surface">{children}</ul></section>;
}

function Switch({ on }: { on: boolean }) {
  return (
    <span role="switch" aria-checked={on} className={cx('relative h-6 w-10 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-line')}>
      <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </span>
  );
}

function Item({
  icon,
  title,
  sub,
  to,
  href,
  onClick,
  right,
  danger,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  to?: string;
  href?: string;
  onClick?: () => void;
  right?: ReactNode;
  danger?: boolean;
}) {
  const inner = (
    <>
      <Icon name={icon} size={22} className={danger ? 'text-danger' : 'text-muted'} />
      <span className="min-w-0 flex-1">
        <span className={cx('block', danger && 'text-danger')}>{title}</span>
        {sub && <span className="mt-0.5 block text-xs leading-5 text-muted">{sub}</span>}
      </span>
      {right ?? ((to || href || onClick) && <Icon name={href ? 'external' : 'chevron'} size={18} className="text-dim" />)}
    </>
  );
  const cls = 'flex min-h-16 w-full items-center gap-4 px-4 py-2 text-left hover:bg-fg/5';
  return (
    <li className="border-b border-line/60 last:border-0">
      {to ? (
        <Link to={to} className={cls}>
          {inner}
        </Link>
      ) : href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
          {inner}
        </a>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={cls}>
          {inner}
        </button>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}
