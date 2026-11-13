import { useState } from 'react';
import { request, withQuery } from '../api/client';
import { Button, Empty, ErrorState, Field, Loading, Notice, PageHeader } from '../components/ui';
import { useAsync, useDebounced } from '../lib/hooks';
import { useLibraryReview } from '../lib/libraryCare';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { attempt } from '../lib/ui';

interface MetadataTrack {
  id: number;
  artist: string;
  title: string;
  album_id: number | null;
  album: string | null;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  genre: string | null;
  release_date: string | null;
  has_cover: boolean;
}
interface Report {
  tracks: MetadataTrack[];
  total: number;
  next_offset: number | null;
  missing_numbers: number;
  missing_years: number;
  missing_covers: number;
  variants: { names: string[]; ids: number[]; total: number }[];
}
export function MetadataPage() {
  const { me } = useSession();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 350);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [artist, setArtist] = useState('');
  const [genre, setGenre] = useState('');
  const [disc, setDisc] = useState('1');
  const [start, setStart] = useState('1');
  const [busy, setBusy] = useState(false);
  const { review, sheet } = useLibraryReview();
  const res = useAsync(
    (s) => request<Report>('GET', withQuery('/api/library/metadata', { q, offset }), { signal: s }),
    [q, offset],
    me.is_admin,
  );
  if (!me.is_admin)
    return (
      <>
        <PageHeader title="Порядок в тегах" back="/more" />
        <Empty icon="lock" title="Доступно администратору" />
      </>
    );
  const d = res.data;
  const ids = (d?.tracks ?? []).filter((t) => selected.includes(t.id)).map((t) => t.id);
  const apply = async (action: 'tracks' | 'number', fields: object, picked = ids) => {
    if (!picked.length) return;
    setBusy(true);
    const result = await attempt(() => review({ action, id: picked[0], ids: picked, fields }), 'Теги обновлены');
    setBusy(false);
    if (result) {
      setSelected([]);
      res.reload(true);
    }
  };
  const changePage = (next: number) => {
    setOffset(next);
    setSelected([]);
  };
  return (
    <div className="pb-8">
      {sheet}
      <PageHeader title="Порядок в тегах" back="/library-health" sub="Исполнители, диски, даты и обложки" />
      <div className="space-y-4 px-4">
        <Notice kind="info">
          Все правки общей библиотеки проходят через предпросмотр. Треки и их UUID сохраняются; разные версии не
          объединяются.
        </Notice>
        <Field label="Найти треки, альбом или исполнителя">
          <input
            type="search"
            maxLength={512}
            className="input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
              setSelected([]);
            }}
          />
        </Field>
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : (
          d && (
            <>
              <p className="text-sm text-muted">
                Найдено треков: {d.total}. Без номера трека или диска: {d.missing_numbers}; без года: {d.missing_years};
                альбомов без обложки: {d.missing_covers}.
              </p>
              {!!d.variants.length && (
                <details className="rounded-xl border border-line p-4">
                  <summary className="cursor-pointer font-semibold">Варианты написания исполнителей</summary>
                  <p className="mt-2 text-xs text-muted">
                    Совпадения только по регистру, пробелам и Unicode. Состав исполнителей и пометки версий не
                    отбрасываются.
                  </p>
                  <div className="mt-3 space-y-4">
                    {d.variants.map((group) => (
                      <section key={group.ids.join(':')}>
                        <p className="break-words text-sm">
                          {group.names.join(' / ')} · треков: {group.total}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {group.names.map((name) => (
                            <Button
                              small
                              key={name}
                              disabled={busy || group.total > 500}
                              onClick={() => void apply('tracks', { artist: name }, group.ids)}
                            >
                              Использовать «{name}»…
                            </Button>
                          ))}
                        </div>
                        {group.total > 500 && (
                          <p className="text-xs text-muted">Больше 500 треков: редактируйте частями через поиск.</p>
                        )}
                      </section>
                    ))}
                  </div>
                </details>
              )}
              <section className="space-y-3 rounded-xl border border-line bg-surface p-4" aria-label="Пакетная правка">
                <h2 className="font-semibold">Выбрано: {ids.length}</h2>
                <p className="text-xs text-muted">
                  Нумерация идёт в порядке списка: альбом → диск → текущий номер. Перед применением проверьте каждый
                  новый номер.
                </p>
                <div className="grid items-end gap-3 sm:grid-cols-2">
                  <Field label="Единое имя исполнителя">
                    <input
                      className="input"
                      maxLength={512}
                      value={artist}
                      onChange={(e) => setArtist(e.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={busy || !ids.length || !artist.trim()}
                    onClick={() => void apply('tracks', { artist: artist.trim() })}
                  >
                    Предпросмотр имени
                  </Button>
                  <Field label="Жанр">
                    <input className="input" maxLength={128} value={genre} onChange={(e) => setGenre(e.target.value)} />
                  </Field>
                  <Button
                    disabled={busy || !ids.length}
                    onClick={() => void apply('tracks', { genre: genre.trim() || null })}
                  >
                    Предпросмотр жанра
                  </Button>
                  <Field label="Номер диска">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={9999}
                      value={disc}
                      onChange={(e) => setDisc(e.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={busy || !ids.length || !disc}
                    onClick={() => void apply('tracks', { disc_no: Number(disc) })}
                  >
                    Предпросмотр диска
                  </Button>
                  <Field label="Нумерация с">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={9999}
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={busy || !ids.length || !start}
                    onClick={() => void apply('number', { start: Number(start) })}
                  >
                    Предпросмотр номеров
                  </Button>
                </div>
              </section>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!d.tracks.length && ids.length === d.tracks.length}
                  onChange={(e) => setSelected(e.target.checked ? d.tracks.map((t) => t.id) : [])}
                />
                Выбрать страницу · до 100 треков
              </label>
              <ul className="divide-y divide-line rounded-xl bg-surface">
                {d.tracks.map((track) => (
                  <li key={track.id} className="flex min-w-0 items-start gap-3 p-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0"
                      aria-label={`Выбрать ${track.artist} — ${track.title}`}
                      checked={ids.includes(track.id)}
                      onChange={(e) =>
                        setSelected((previous) =>
                          e.target.checked ? [...previous, track.id] : previous.filter((id) => id !== track.id),
                        )
                      }
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="break-words font-semibold">
                        {track.artist} — {track.title}
                      </p>
                      <p className="text-muted">
                        {track.album || 'Без альбома'} · диск {track.disc_no ?? '—'} · № {track.track_no ?? '—'} ·{' '}
                        {track.release_date || track.year || 'Дата не задана'}
                      </p>
                      {!track.has_cover && <p className="text-xs text-warn">Нет обложки альбома</p>}
                      {track.album_id && (
                        <Link
                          className="inline-block py-2 text-accent underline"
                          to={`/library/album/${track.album_id}`}
                        >
                          Дата, обложка и теги альбома →
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {!d.tracks.length && <Empty icon="search" title="Ничего не найдено" />}
              <div className="flex justify-between gap-3">
                <Button disabled={!offset || busy} onClick={() => changePage(Math.max(0, offset - 100))}>
                  Назад
                </Button>
                <Button disabled={d.next_offset == null || busy} onClick={() => changePage(d.next_offset!)}>
                  Дальше
                </Button>
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
