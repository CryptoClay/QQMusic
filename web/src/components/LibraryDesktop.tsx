import type { ReactNode } from 'react';
import { libraryCoverUrl } from '../api/client';
import type { LibAlbumOut } from '../api/types';
import { recordTypeLabel, tracksWord } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { Icon } from './Icon';
import { Button, Cover, Empty, ErrorState, Loading } from './ui';

type Props = {
  query: string;
  onQuery: (value: string) => void;
  searching: boolean;
  albums: LibAlbumOut[];
  loading: boolean;
  error?: string;
  retry: () => void;
  offerImport: boolean;
  canMore: boolean;
  moreBusy: boolean;
  loadMore: () => void;
  onCreate: () => void;
  createSheet: ReactNode;
};

/** The desktop browser gets a compact collection view; app and touch layouts remain in LibraryPage. */
export function DesktopLibrary({ query, onQuery, searching, albums, loading, error, retry, offerImport, canMore, moreBusy, loadMore, onCreate, createSheet }: Props) {
  return (
    <div className="px-6 pb-8 pt-7 xl:px-8">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Библиотека</h1>
          <p className="mt-1.5 text-sm text-muted">Ваша музыка и любимые подборки</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => navigate('/import')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line px-4 text-sm font-medium transition hover:bg-hover">
            <Icon name="transfer" size={18} /> Перенести
          </button>
          <button type="button" onClick={onCreate} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line px-4 text-sm font-medium transition hover:bg-hover">
            <Icon name="plus" size={18} /> Создать альбом
          </button>
          <button type="button" onClick={() => navigate('/upload')} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#ff9349] px-4 text-sm font-semibold text-[#261509] transition hover:bg-[#ffad70]">
            <Icon name="upload" size={18} /> Загрузить файлы
          </button>
        </div>
      </header>

      <section aria-labelledby="library-files" className="mt-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="library-files" className="text-xl font-bold">Мои файлы</h2>
            <p className="mt-1 text-sm text-muted">Альбомы в вашей библиотеке</p>
          </div>
          <div className="relative w-full max-w-sm">
            <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input h-11 rounded-xl pl-10" type="search" placeholder="Поиск по альбомам" aria-label="Поиск по альбомам" value={query} onChange={(e) => onQuery(e.target.value)} />
          </div>
        </div>

        {offerImport && (
          <Link to="/import" className="mt-6 flex items-center gap-3 rounded-xl border border-line bg-surface p-4 transition hover:bg-hover">
            <Icon name="transfer" size={22} className="shrink-0 text-[#ff9349]" />
            <span className="min-w-0 flex-1"><span className="block font-semibold">Перенести музыку из Яндекс Музыки</span><span className="mt-1 block text-sm text-muted">Понравившиеся, плейлисты, альбомы и исполнители</span></span>
            <Icon name="chevron" size={18} className="shrink-0 text-muted" />
          </Link>
        )}

        <div className="mt-6">
          {loading ? <Loading text="Загружаем библиотеку…" /> : error ? <ErrorState text={error} onRetry={retry} /> : albums.length === 0 ? (
            searching ? (
              <Empty icon="search" title="Ничего не найдено" text="Попробуйте изменить поисковый запрос.">
                <Button small onClick={() => onQuery('')}>Очистить поиск</Button>
              </Empty>
            ) : (
              <Empty icon="library" title="Библиотека пуста" text="Найдите музыку или загрузите свои файлы, чтобы начать собирать коллекцию.">
                <div className="mt-2 flex gap-2"><Button small icon="search" onClick={() => navigate('/search')}>Поиск</Button><Button small icon="upload" onClick={() => navigate('/upload')}>Загрузить</Button></div>
              </Empty>
            )
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,160px),1fr))] gap-x-5 gap-y-7">
                {albums.map((album) => {
                  const detail = [album.album_artist, album.year].filter(Boolean).join(' · ');
                  const info = [recordTypeLabel(album.release_type), tracksWord(album.track_count)].filter(Boolean).join(' · ');
                  return (
                    <Link key={album.id} to={`/library/album/${album.id}`} className="group min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#ff9349]" title={album.title}>
                      <Cover src={album.has_cover ? libraryCoverUrl(album.id, 300) : null} alt={album.title} className="aspect-square w-full transition group-hover:opacity-85" icon="disc" />
                      <div className="mt-3 line-clamp-2 break-words text-sm font-semibold leading-5" title={album.title}>{album.title}</div>
                      {detail && <div className="mt-1 truncate text-sm text-muted" title={detail}>{detail}</div>}
                      {info && <div className="mt-0.5 truncate text-xs text-muted" title={info}>{info}</div>}
                    </Link>
                  );
                })}
              </div>
              {canMore && <div className="flex justify-center pt-8"><Button busy={moreBusy} onClick={loadMore}>Показать ещё</Button></div>}
            </>
          )}
        </div>
      </section>
      {createSheet}
    </div>
  );
}
