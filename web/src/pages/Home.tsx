import { api } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { WaveCard } from '../components/Wave';
import { WaveHero } from '../components/WaveHero';
import { ErrorState, SectionTitle, Spinner } from '../components/ui';
import { useDesktop } from '../lib/desktop';
import { useHubEvent } from '../lib/events';
import { useAsync } from '../lib/hooks';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { AlbumRow, ArtistRow } from './MediaLibrary';
import { HomeMix } from '../components/HomeMix';
import { MixCard } from './Mix';

/** «Главная» of the PWA in a plain browser (`STANDALONE`), like the app's: «Микс дня», «Моя волна», shortcuts to
 * the library, «Радиостанции» (a wave by a library artist, liked ones first) and rows of albums Navidrome knows the
 * user plays. Inside the app this is its native home screen. */
export function HomePage() {
  const { me } = useSession();
  const res = useAsync((s) => api.ndHome(s), []);
  useHubEvent('library', () => res.reload(true));
  const d = res.data;
  const desktop = useDesktop();

  return (
    <div className="pb-4">
      <header className={desktop ? 'px-4 pb-1 pt-7' : 'pt-safe px-4 pb-1 pt-4'}>
        <h1 className={desktop ? 'text-3xl font-bold tracking-tight' : 'text-2xl font-bold'}>{greeting()}, {me.username}</h1>
        {desktop && <p className="mt-1 text-sm text-muted">Всё, что вы любите слушать — в одном месте</p>}
      </header>
      {desktop ? (
        <>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] items-stretch gap-3 px-4 pt-4">
            <WaveHero />
            <HomeMix />
          </div>
          <div className="grid grid-cols-2 gap-3 px-4 pt-5 min-[1280px]:grid-cols-4">
            <Shortcut to="/liked" icon="heart" title="Понравившиеся" hint="Ваши любимые треки" />
            <Shortcut to="/playlists" icon="playlist" title="Плейлисты" hint="Ваши подборки" />
            <Shortcut to="/artists" icon="user" title="Исполнители" hint="Любимые артисты" />
            <Shortcut to="/lib/albums" icon="disc" title="Альбомы" hint="Вся коллекция" />
          </div>
        </>
      ) : (
        <>
          <MixCard />
          <WaveCard />
          <div className="grid grid-cols-2 gap-2 px-4 pt-3">
            <Shortcut to="/liked" icon="heart" title="Понравившиеся" />
            <Shortcut to="/playlists" icon="playlist" title="Плейлисты" />
            <Shortcut to="/artists" icon="user" title="Исполнители" />
            <Shortcut to="/lib/albums" icon="disc" title="Все альбомы" />
          </div>
        </>
      )}

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
              Здесь появится ваша музыка. <Link to="/search" className="text-[#ffad78] underline">Найдите треки</Link> или <Link to="/upload" className="text-[#ffad78] underline">загрузите свои файлы</Link>.
            </div>
          )}
          {d.radio.length > 0 && (
            <section aria-label="Радиостанции">
              <SectionTitle right={<Link to="/artists" className="text-sm text-muted hover:text-fg">Все</Link>}>Радиостанции</SectionTitle>
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

function Shortcut({ to, icon, title, hint }: { to: string; icon: IconName; title: string; hint?: string }) {
  return (
    <Link to={to} className={hint ? 'flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-[#3b3734] bg-[#252424] px-4 py-3 transition hover:bg-[#34302d]' : 'flex min-h-14 items-center gap-2.5 rounded-lg bg-raised px-3 py-2 text-sm font-semibold transition hover:bg-hover'}>
      <Icon name={icon} size={20} className={hint ? 'shrink-0 text-[#ff9a54]' : 'shrink-0 text-accent'} />
      <span className="min-w-0"><span className="block truncate text-sm font-semibold">{title}</span>{hint && <span className="block truncate text-xs text-[#b5b0ac]">{hint}</span>}</span>
    </Link>
  );
}
