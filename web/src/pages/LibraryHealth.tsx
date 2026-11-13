import { useState } from 'react';
import { request, withQuery } from '../api/client';
import { Button, Empty, ErrorState, Loading, Notice, PageHeader } from '../components/ui';
import { fmtDuration } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { useLibraryReview } from '../lib/libraryCare';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { attempt } from '../lib/ui';

interface Health {
  tracks: number;
  albums: number;
  bytes: number;
  missing: number;
  unlinked: number;
  duplicate_groups: number;
  album_group_count: number;
  issue_count: number;
  duplicates: {
    title: string;
    artist: string;
    reason: string;
    tracks: {
      id: number;
      album_id: number | null;
      album: string | null;
      duration_s: number | null;
      codec: string | null;
      bitrate_kbps: number | null;
      path: string;
      locked: boolean;
    }[];
  }[];
  album_groups: { id: number; title: string; artist: string; year: number | null }[][];
  issues: { id: number; album_id: number | null; title: string; artist: string; missing: boolean; unlinked: boolean }[];
}

export function LibraryHealthPage() {
  const { me } = useSession();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const res = useAsync(
    (signal) => request<Health>('GET', withQuery('/api/library/health', { offset: page * 50, limit: 50 }), { signal }),
    [page],
    me.is_admin,
  );
  const { review, sheet } = useLibraryReview();
  if (!me.is_admin)
    return (
      <div>
        <PageHeader title="Проверка библиотеки" back="/more" />
        <Empty icon="lock" title="Доступно администратору" text="Общую библиотеку обслуживает администратор сервиса." />
      </div>
    );
  const merge = async (id: number, ids: number[]) => {
    setBusy(true);
    const result = await attempt(() => review({ action: 'merge', id, ids }), 'Альбомы объединены');
    setBusy(false);
    if (result) res.reload();
  };
  return (
    <div className="pb-10">
      <PageHeader
        title="Проверка библиотеки"
        sub="Дубли, файлы и теги"
        back="/more"
        right={
          <Button small icon="refresh" onClick={() => res.reload()} disabled={res.loading || busy}>
            Обновить
          </Button>
        }
      />
      <div className="space-y-6 px-4">
        <Link to="/metadata" className="block rounded-xl border border-line bg-surface p-4 font-semibold text-accent">Порядок в тегах: исполнители, диски, даты и обложки →</Link>
        <Notice kind="info">
          Проверка читает файлы и теги. Изменения применяются только после предпросмотра. Похожие записи могут быть
          разными версиями.
        </Notice>
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : (
          res.data && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  ['Треков', res.data.tracks],
                  ['Альбомов', res.data.albums],
                  ['Групп похожих треков', res.data.duplicate_groups],
                  ['Файлов не найдено', res.data.missing],
                ].map(([label, count]) => (
                  <div key={label} className="rounded-xl border border-line bg-surface p-4">
                    <p className="text-2xl font-bold">{count}</p>
                    <p className="text-sm text-muted">{label}</p>
                  </div>
                ))}
              </div>
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">Похожие треки</h2>
                {!res.data.duplicate_groups && (
                  <p className="text-sm text-muted">
                    Совпадений по названию, исполнителю и близкой длительности не найдено.
                  </p>
                )}
                {res.data.duplicates.map((group) => (
                  <article
                    key={group.tracks.map((t) => t.id).join(':')}
                    className="min-w-0 rounded-xl border border-line bg-surface p-4"
                  >
                    <h3 className="break-words font-semibold">
                      {group.artist} — {group.title}
                    </h3>
                    <p className="mt-1 text-xs text-muted">{group.reason}</p>
                    <ul className="mt-3 divide-y divide-line">
                      {group.tracks.map((t) => (
                        <li key={t.id} className="py-3 text-sm">
                          <p>
                            {[
                              t.album,
                              fmtDuration(t.duration_s),
                              t.codec?.toUpperCase(),
                              t.bitrate_kbps && `${t.bitrate_kbps} кбит/с`,
                              t.locked && 'Оригинальная копия',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                          <p className="mt-1 break-all text-xs text-dim">{t.path}</p>
                          {t.album_id && (
                            <Link
                              className="mt-2 inline-block py-1 font-semibold text-accent"
                              to={`/library/album/${t.album_id}`}
                            >
                              Открыть альбом и теги →
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </section>
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">Повторяющиеся альбомы</h2>
                <p className="text-sm text-muted">
                  При объединении сохраняются все треки и их UUID. Основной альбом выбирается вручную.
                </p>
                {!res.data.album_group_count && (
                  <p className="text-sm text-muted">Повторяющихся альбомов не найдено.</p>
                )}
                {res.data.album_groups.map((group) => (
                  <article
                    key={group.map((a) => a.id).join(':')}
                    className="rounded-xl border border-line bg-surface p-4"
                  >
                    <h3 className="mb-3 break-words font-semibold">
                      {group[0].artist} — {group[0].title} {group[0].year && `· ${group[0].year}`}
                    </h3>
                    <div className="space-y-3">
                      {group.map((a) => (
                        <div key={a.id} className="flex flex-wrap items-center gap-3 text-sm">
                          <Link className="text-accent" to={`/library/album/${a.id}`}>
                            Альбом №{a.id} →
                          </Link>
                          <Button
                            small
                            disabled={busy}
                            onClick={() =>
                              merge(
                                a.id,
                                group.filter((x) => x.id !== a.id).map((x) => x.id),
                              )
                            }
                          >
                            Оставить основным…
                          </Button>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">Файлы и индексация</h2>
                {!res.data.issue_count ? (
                  <p className="text-sm text-muted">Все записи найдены на диске и связаны с Navidrome.</p>
                ) : (
                  <>
                    <p className="text-sm text-muted">
                      Не найдено файлов: {res.data.missing}. Ожидают связи с Navidrome: {res.data.unlinked}.
                    </p>
                    {res.data.issues.map((t) => (
                      <div key={t.id} className="rounded-xl border border-line p-3 text-sm">
                        <p className="break-words">
                          {t.artist} — {t.title}
                        </p>
                        <p className="text-warn">
                          {t.missing
                            ? 'Файл отсутствует: проверьте диск и MUSIC_ROOT'
                            : 'Ожидает сканирования Navidrome'}
                        </p>
                        {t.album_id && (
                          <Link className="inline-block py-2 text-accent" to={`/library/album/${t.album_id}`}>
                            Открыть альбом →
                          </Link>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </section>
              {Math.max(res.data.duplicate_groups, res.data.album_group_count, res.data.issue_count) > 50 && (
                <nav className="flex items-center justify-between gap-3" aria-label="Страницы проверки библиотеки">
                  <Button disabled={!page} onClick={() => setPage((p) => p - 1)}>
                    Назад
                  </Button>
                  <span className="text-sm">Страница {page + 1}</span>
                  <Button
                    disabled={
                      (page + 1) * 50 >=
                      Math.max(res.data.duplicate_groups, res.data.album_group_count, res.data.issue_count)
                    }
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Далее
                  </Button>
                </nav>
              )}
            </>
          )
        )}
      </div>
      {sheet}
    </div>
  );
}
