import { PersonalHomeSections } from './Experience';
import { api } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { WaveHero } from '../components/WaveHero';
import { ErrorState, SectionTitle, Spinner } from '../components/ui';
import { useDesktop } from '../lib/desktop';
import { useHubEvent } from '../lib/events';
import { useAsync } from '../lib/hooks';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { AlbumRow, ArtistRow } from './MediaLibrary';
import { HomeMix } from '../components/HomeMix';
import { DeviceButton } from '../components/PlayerTools';

export function HomePage() {
  const { me } = useSession();
  const res = useAsync((s) => api.ndHome(s), []);
  useHubEvent('library', () => res.reload(true));
  const d = res.data;
  const desktop = useDesktop();

  return (
    <div className="pb-4">
      <header
        className={
          desktop
            ? 'flex items-center justify-between gap-3 px-4 pb-5 pt-7'
            : 'pt-safe flex items-center justify-between gap-3 px-4 pb-4 pt-4'
        }
      >
        <div>
          <p className="text-sm text-muted">
            {greeting()}, {me.username}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Для тебя</h1>
        </div>
        <DeviceButton />
      </header>
      <div className="grid items-stretch gap-3 px-4 min-[1100px]:grid-cols-[minmax(0,1.8fr)_minmax(280px,1fr)]">
        <WaveHero />
        <HomeMix />
      </div>
      <div className="grid grid-cols-2 gap-2 px-4 pb-2 pt-4 min-[1280px]:grid-cols-4">
        <Shortcut
          to="/liked"
          icon="heart"
          title="Любимые треки"
          hint="Всегда рядом"
          color="text-[#ff9d79] bg-[#4c2d30]"
        />
        <Shortcut
          to="/playlists"
          icon="playlist"
          title="Плейлисты"
          hint="Ваши истории"
          color="text-[#b8a0ff] bg-[#352c4e]"
        />
        <Shortcut
          to="/artists"
          icon="user"
          title="Исполнители"
          hint="Знакомые голоса"
          color="text-[#7fcecb] bg-[#203e40]"
        />
        <Shortcut
          to="/lib/albums"
          icon="disc"
          title="Альбомы"
          hint="Слушать целиком"
          color="text-[#e9bb7e] bg-[#473921]"
        />
      </div>
      <PersonalHomeSections />

      {res.loading ? (
        <div className="flex justify-center py-10">
          <Spinner className="text-accent" />
        </div>
      ) : res.error ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : d ? (
        <>
          {!d.radio.length && !d.recent.length && !d.frequent.length && !d.starred.length && !d.newest.length && (
            <div className="mx-4 mt-6 rounded-xl border border-line bg-surface p-5 text-sm text-muted">
              Здесь появится ваша музыка.{' '}
              <Link to="/search" className="text-[#ffad78] underline">
                Найдите треки
              </Link>{' '}
              или{' '}
              <Link to="/upload" className="text-[#ffad78] underline">
                загрузите свои файлы
              </Link>
              .
            </div>
          )}
          {d.radio.length > 0 && (
            <section aria-label="Радиостанции">
              <SectionTitle
                right={
                  <Link to="/artists" className="text-sm text-muted hover:text-fg">
                    Все
                  </Link>
                }
              >
                Радиостанции
              </SectionTitle>
              <ArtistRow artists={d.radio} rowKey="home:radio" radio />
            </section>
          )}
          <AlbumRow title="Недавно слушали" albums={d.recent} rowKey="home:recent" />
          <AlbumRow title="Часто слушаете" albums={d.frequent} rowKey="home:frequent" />
          <AlbumRow title="Понравившиеся альбомы" albums={d.starred} rowKey="home:starred" more="/liked" />
          <AlbumRow title="Новое в библиотеке" albums={d.newest} rowKey="home:newest" more="/lib/albums" />
        </>
      ) : null}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
}

function Shortcut({
  to,
  icon,
  title,
  hint,
  color,
}: {
  to: string;
  icon: IconName;
  title: string;
  hint: string;
  color: string;
}) {
  return (
    <Link
      to={to}
      className="group flex min-h-20 min-w-0 items-center gap-2 rounded-2xl bg-white/[.035] px-3 py-3 transition hover:bg-white/[.075]"
    >
      <span className={`flex h-8 w-8 shrink-0 sm:h-10 sm:w-10 items-center justify-center rounded-xl ${color}`}>
        <Icon name={icon} size={21} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold sm:text-sm">{title}</span>
        <span className="mt-1 hidden truncate text-xs text-muted min-[400px]:block">{hint}</span>
      </span>
    </Link>
  );
}
