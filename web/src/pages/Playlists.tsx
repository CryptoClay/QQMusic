import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorState, PageHeader, SkeletonRows } from '../components/ui';
import { fmtLength, tracksWord } from '../lib/format';
import { useDesktop } from '../lib/desktop';
import { STANDALONE } from '../lib/embedded';
import { useAsync } from '../lib/hooks';
import { Link, enc } from '../lib/router';
import { attempt } from '../lib/ui';

export function PlaylistsPage() {
  const res = useAsync((s) => api.playlists(s), []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const desktop = useDesktop();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const p = await attempt(() => api.createPlaylist(name.trim()), 'Плейлист создан');
    setBusy(false);
    if (p) {
      setName('');
      res.setData((prev) => [p, ...(prev ?? [])]);
    }
  };

  if (desktop) return (
    <div className="px-6 pb-8 pt-7 xl:px-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Плейлисты</h1>
        <p className="mt-1.5 text-sm text-muted">Ваши подборки из библиотеки Navidrome</p>
      </header>
      <form onSubmit={create} className="mt-8 flex max-w-2xl items-center gap-3">
        <input className="input h-11 min-w-0 flex-1 rounded-xl" placeholder="Название нового плейлиста" aria-label="Название нового плейлиста" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" icon="plus" busy={busy} disabled={!name.trim()} className="!min-h-11 !rounded-xl">Создать</Button>
      </form>
      <section className="mt-9" aria-label="Ваши плейлисты">
        <h2 className="text-xl font-bold">Ваши плейлисты</h2>
        <div className="mt-4">
          {res.loading ? <SkeletonRows /> : res.error ? <ErrorState text={res.error} onRetry={() => res.reload()} /> : !res.data?.length ? (
            <Empty icon="playlist" title="Плейлистов пока нет" text="Создайте плейлист выше или добавьте в него альбом со страницы альбома." />
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3">
              {res.data.map((p) => (
                <li key={p.id} className="min-w-0">
                  <Link to={`/playlist/${enc(p.id)}`} title={p.name} className="group flex min-h-20 items-center gap-4 rounded-xl border border-line bg-surface p-3 transition hover:bg-hover">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#3e2b20] text-accent"><Icon name="playlist" size={22} /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{p.name}</span><span className="mt-1 block truncate text-sm text-muted">{[tracksWord(p.song_count), p.duration_s ? fmtLength(p.duration_s) : null].filter(Boolean).join(' · ')}</span></span>
                    <Icon name="chevron" size={18} className="shrink-0 text-muted group-hover:text-fg" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );

  return (
    <div>
      <PageHeader title="Плейлисты" back={STANDALONE ? '/library' : '/more'} />
      <form onSubmit={create} className="flex gap-2 px-4 pb-3">
        <input className="input flex-1" placeholder="Название нового плейлиста" aria-label="Название нового плейлиста" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" icon="plus" busy={busy} disabled={!name.trim()}>
          Создать
        </Button>
      </form>
      <p className="px-4 pb-2 text-xs text-muted">
        {STANDALONE
          ? 'Плейлисты хранятся в Navidrome: те же, что в Android-приложении.'
          : 'Плейлисты хранятся в Navidrome: слушайте и скачивайте их для офлайна в Android-приложении.'}
      </p>
      {res.loading ? (
        <SkeletonRows />
      ) : res.error ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : !res.data?.length ? (
        <Empty icon="playlist" title="Плейлистов пока нет" text="Создайте плейлист здесь или добавьте в него альбом со страницы альбома." />
      ) : (
        <ul>
          {res.data.map((p) => (
            <li key={p.id}>
              <PlaylistRow to={STANDALONE ? `/playlist/${enc(p.id)}` : undefined}>
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-[#1f6f43] to-[#1a1a1a] text-fg">
                <Icon name="playlist" size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.name}</span>
                <span className="block text-xs text-muted">{[tracksWord(p.song_count), p.duration_s ? fmtLength(p.duration_s) : null].filter(Boolean).join(' · ')}</span>
              </span>
              {STANDALONE && <Icon name="chevron" size={18} className="text-dim" />}
              </PlaylistRow>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A playlist opens (its songs, «Слушать») in a browser; inside the app the app's own library has it. */
function PlaylistRow({ to, children }: { to?: string; children: ReactNode }) {
  const cls = 'flex min-h-16 items-center gap-3 px-4 py-2';
  return to ? (
    <Link to={to} className={cls + ' hover:bg-fg/5'}>
      {children}
    </Link>
  ) : (
    <div className={cls}>{children}</div>
  );
}
