import { useEffect, useState } from 'react';
import { api, request, withQuery } from '../api/client';
import { Button, Empty, ErrorState, Field, Loading, Notice, PageHeader } from '../components/ui';
import {
  community,
  type Collection,
  type Group,
  type Inbox,
  type LibrarySong,
  type MusicRequest,
  type Policy,
  type SharedLink,
  type Snapshot,
} from '../lib/community';
import { useHubEvent } from '../lib/events';
import { fmtDeadline, fmtDuration, fmtWhen } from '../lib/format';
import { useAsync, useDebounced } from '../lib/hooks';
import { listenAll, resumeRemote } from '../lib/listen';
import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { attempt, confirmDialog } from '../lib/ui';

const LINKS = [
  ['/requests', 'Заявки на музыку', 'Попросить трек или альбом и узнать, когда он готов'],
  ['/community-playlists', 'Совместные плейлисты', 'Участники, роли и подборки вместе'],
  ['/resume', 'Продолжить слушать', 'Очередь и позиция с другого устройства'],
  ['/versions', 'Версии треков', 'Оригинал, clean, live и личный выбор версии'],
  ['/shares', 'Общие ссылки', 'Поделиться музыкой, задать срок и отозвать доступ'],
  ['/limits', 'Мои лимиты', 'Очередь, место и размер загружаемых файлов'],
  ['/inbox', 'Уведомления', 'Готовность музыки и доступ к плейлистам'],
] as const;

export function CommunityPage() {
  const inbox = useAsync((s) => community<Inbox>('/inbox', s), []);
  return (
    <div className="pb-8">
      <PageHeader title="Музыка вместе" back="/more" />
      <div className="grid gap-3 px-4 md:grid-cols-2">
        {LINKS.map(([to, title, sub]) => (
          <Link key={to} to={to} className="min-w-0 rounded-xl border border-line bg-surface p-5 hover:bg-hover">
            <h2 className="text-lg font-semibold">
              {title}
              {to === '/inbox' && !!inbox.data?.unread && <span className="ml-2 text-accent">{inbox.data.unread}</span>}
            </h2>
            <p className="mt-1 text-sm text-muted">{sub}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

function catalogRef(value: string) {
  const text = value.trim();
  const found = /(?:album|track)\/([^?&#/]+)/.exec(text)?.[1];
  try {
    return found ? decodeURIComponent(found) : text;
  } catch {
    return text;
  }
}

const statuses: Record<string, string> = {
  pending: 'Ждёт рассмотрения',
  preparing: 'Готовится',
  ready: 'Готово',
  failed: 'Не удалось скачать',
  rejected: 'Отклонена',
  cancelled: 'Отменена',
};
export function RequestsPage({
  initial,
}: {
  initial?: { artist: string; title: string; ref: string; kind: 'track' | 'album' };
}) {
  const { me } = useSession();
  const res = useAsync((s) => community<MusicRequest[]>('/requests', s), []);
  const [artist, setArtist] = useState(initial?.artist ?? ''),
    [title, setTitle] = useState(initial?.title ?? ''),
    [ref, setRef] = useState(initial?.ref ?? ''),
    [kind, setKind] = useState<'track' | 'album'>(initial?.kind ?? 'track'),
    [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<number, string>>({});
  useHubEvent('community', () => res.reload(true));
  const send = async () => {
    setBusy(true);
    const r = await attempt(
      () =>
        request('POST', '/api/community/requests', {
          json: { artist: artist.trim(), title: title.trim(), ref: catalogRef(ref) || null, kind },
        }),
      'Заявка отправлена',
    );
    setBusy(false);
    if (r) {
      setTitle('');
      setRef('');
      res.reload();
    }
  };
  const decide = async (row: MusicRequest, action: 'approve' | 'reject') => {
    if (
      !(await confirmDialog({
        title: action === 'approve' ? 'Принять заявку в загрузку?' : 'Отклонить заявку?',
        body: `${row.artist} — ${row.title}`,
        okLabel: action === 'approve' ? 'Скачать' : 'Отклонить',
      }))
    )
      return;
    setBusy(true);
    await attempt(() =>
      request('POST', `/api/community/requests/${row.id}/decision`, { json: { action, note: notes[row.id] ?? '' } }),
    );
    setBusy(false);
    res.reload();
  };
  return (
    <div className="pb-8">
      <PageHeader
        title="Заявки на музыку"
        sub={me.is_admin ? 'Все заявки сервиса' : 'Ваши заявки и их готовность'}
        back="/community"
        right={
          <Button small onClick={() => res.reload()}>
            Обновить
          </Button>
        }
      />
      <div className="space-y-5 px-4">
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Исполнитель">
              <input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={512} />
            </Field>
            <Field label={kind === 'album' ? 'Альбом' : 'Название трека'}>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={512} />
            </Field>
          </div>
          <Field label="Что добавить">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="track">Трек</option>
              <option value="album">Альбом</option>
            </select>
          </Field>
          <Field label={kind === 'album' ? 'Ссылка на альбом в QQMusic' : 'Ссылка на трек в QQMusic (необязательно)'}>
            <input
              className="input"
              placeholder="dz:123"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              maxLength={200}
            />
          </Field>
          <p className="text-xs text-muted">
            Для альбома скопируйте адрес его страницы в QQMusic. До 50 заявок в сутки.
          </p>
          <Button
            variant="primary"
            busy={busy}
            disabled={!artist.trim() || !title.trim() || (kind === 'album' && !ref.trim())}
            onClick={send}
          >
            Отправить заявку
          </Button>
        </div>
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : !res.data?.length ? (
          <Empty icon="note" title="Заявок пока нет" text="Попросите музыку через форму выше." />
        ) : (
          res.data.map((row) => (
            <article key={row.id} className="space-y-2 rounded-xl border border-line p-4">
              <h2 className="break-words font-semibold">
                {row.artist} — {row.title}
              </h2>
              <p className="text-sm text-muted">
                {statuses[row.status] ?? row.status} · {row.kind === 'album' ? 'Альбом' : 'Трек'}
                {me.is_admin && ` · ${row.username}`}
              </p>
              {row.note && <p className="text-sm">{row.note}</p>}
              {me.is_admin && ['pending', 'failed'].includes(row.status) && (
                <Field label="Комментарий для заявителя">
                  <textarea
                    className="input"
                    maxLength={1000}
                    value={notes[row.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                  />
                </Field>
              )}
              <div className="flex flex-wrap gap-2">
                {me.is_admin && ['pending', 'failed'].includes(row.status) && (
                  <>
                    <Button small busy={busy} onClick={() => decide(row, 'approve')}>
                      Принять
                    </Button>
                    <Button small disabled={busy} onClick={() => decide(row, 'reject')}>
                      Отклонить
                    </Button>
                  </>
                )}
                {row.user_id === me.id && row.status === 'pending' && (
                  <Button
                    small
                    disabled={busy}
                    onClick={async () => {
                      await attempt(() => request('DELETE', `/api/community/requests/${row.id}`));
                      res.reload();
                    }}
                  >
                    Отменить
                  </Button>
                )}
                {row.status === 'ready' && (
                  <Link className="py-2 text-sm font-semibold text-accent" to="/library">
                    Открыть библиотеку →
                  </Link>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

export function InboxPage() {
  const res = useAsync((s) => community<Inbox>('/inbox', s), []);
  useHubEvent('community', () => res.reload(true));
  return (
    <div className="pb-8">
      <PageHeader
        title="Уведомления"
        back="/community"
        right={
          <Button
            small
            disabled={!res.data?.unread}
            onClick={async () => {
              await attempt(() => request('POST', '/api/community/inbox/read', { json: [] }));
              res.reload();
            }}
          >
            Прочитать всё
          </Button>
        }
      />
      <div className="space-y-3 px-4">
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : !res.data?.messages.length ? (
          <Empty icon="bell" title="Новых событий пока нет" />
        ) : (
          res.data.messages.map((m) => (
            <Link
              key={m.id}
              to={m.target}
              onClick={() => void request('POST', '/api/community/inbox/read', { json: [m.id] })}
              className={`block rounded-xl border p-4 ${m.read ? 'border-line' : 'border-accent/60 bg-accent/5'}`}
            >
              <p className="break-words font-medium">{m.text}</p>
              <p className="mt-1 text-xs text-muted">
                {fmtWhen(m.created_at)}
                {!m.read ? ' · Новое' : ''}
              </p>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

export function LibrarySearch({
  onPick,
  disabled = false,
}: {
  onPick: (song: LibrarySong) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const res = useAsync((s) => community<LibrarySong[]>(withQuery('/library-search', { q: query }), s), [query]);
  return (
    <div className="space-y-2">
      <Field label="Найти трек в библиотеке">
        <input
          type="search"
          className="input"
          placeholder="Название или исполнитель"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </Field>
      {res.loading ? (
        <Loading />
      ) : res.error ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {!res.data?.length ? (
            <li className="p-3 text-sm text-muted">Треки не найдены. Сначала добавьте музыку в библиотеку.</li>
          ) : (
            res.data.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={disabled}
                  className="w-full break-words px-3 py-3 text-left text-sm hover:bg-hover disabled:opacity-50"
                  onClick={() => onPick(t)}
                >
                  <span className="block font-semibold">{t.title}</span>
                  <span className="text-muted">
                    {t.artist} · {fmtDuration(t.duration_s)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export function CommunityPlaylistsPage() {
  const [archived, setArchived] = useState(false);
  const res = useAsync((s) => community<Collection[]>(withQuery('/playlists', { archived }), s), [archived]);
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [source, setSource] = useState('');
  const native = useAsync((s) => api.playlists(s), []);
  useHubEvent('community', () => res.reload(true));
  return (
    <div className="pb-8">
      <PageHeader
        title={archived ? 'Архив плейлистов' : 'Совместные плейлисты'}
        back="/community"
        right={
          <Button small onClick={() => setArchived((v) => !v)}>
            {archived ? 'Действующие' : 'Архив'}
          </Button>
        }
      />
      <div className="space-y-4 px-4">
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <Field label="Название плейлиста">
            <input className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Начать с">
            <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Пустого плейлиста</option>
              {native.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-muted">
            При переносе создаётся отдельная совместная копия. Личный плейлист сохраняется.
          </p>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              const row = await attempt(() =>
                request<Collection>('POST', '/api/community/playlists', {
                  json: { name: name.trim(), nd_playlist_id: source || null },
                }),
              );
              setBusy(false);
              if (row) navigate(`/community-playlist/${row.id}`);
            }}
          >
            Создать
          </Button>
        </div>
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : !res.data?.length ? (
          <Empty icon="playlist" title="Совместных плейлистов пока нет" />
        ) : (
          res.data.map((p) => (
            <Link
              key={p.id}
              className="block rounded-xl border border-line p-4 hover:bg-hover"
              to={`/community-playlist/${p.id}`}
            >
              <h2 className="break-words font-semibold">{p.name}</h2>
              <p className="mt-1 text-sm text-muted">
                Треков: {p.items.length} · Участников: {p.members.length} ·{' '}
                {p.role === 'owner' ? 'Владелец' : p.role === 'editor' ? 'Редактор' : 'Слушатель'}
              </p>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

export function CommunityPlaylistPage({ id }: { id: number }) {
  const res = useAsync((s) => community<Collection>(`/playlists/${id}`, s), [id]);
  const [busy, setBusy] = useState(false),
    [username, setUsername] = useState(''),
    [role, setRole] = useState('listener');
  const [rename, setRename] = useState('');
  useEffect(() => setRename(res.data?.name ?? ''), [res.data?.name]);
  useHubEvent('community', () => res.reload(true));
  const save = async (fields: object) => {
    const row = res.data;
    if (!row) return;
    setBusy(true);
    const r = await attempt(() =>
      request<Collection>('PATCH', `/api/community/playlists/${id}`, { json: { revision: row.revision, ...fields } }),
    );
    setBusy(false);
    if (r) res.setData(r);
    else res.reload(true);
  };
  const p = res.data;
  return (
    <div className="pb-8">
      <PageHeader
        title={p?.name ?? 'Совместный плейлист'}
        back="/community-playlists"
        right={
          <Button small onClick={() => res.reload()}>
            Обновить
          </Button>
        }
      />
      <div className="space-y-5 px-4">
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : (
          p && (
            <>
              {p.role !== 'listener' && !p.archived && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Название плейлиста">
                    <input
                      className="input"
                      value={rename}
                      maxLength={200}
                      onChange={(e) => setRename(e.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={busy || !rename.trim() || rename.trim() === p.name}
                    onClick={() => void save({ name: rename.trim() })}
                  >
                    Переименовать
                  </Button>
                </div>
              )}
              <p className="text-sm text-muted">
                Треков: {p.items.length} ·{' '}
                {p.role === 'owner' ? 'Вы владелец' : p.role === 'editor' ? 'Вы редактор' : 'Доступ для прослушивания'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!p.items.length || p.archived}
                  onClick={() => listenAll(p.items, { context: 'other' })}
                >
                  Слушать
                </Button>
                {p.role === 'owner' && (
                  <Button onClick={() => navigate(`/shares?collection=${p.id}`)}>Поделиться</Button>
                )}
              </div>
              {p.role !== 'listener' && !p.archived && (
                <LibrarySearch
                  disabled={busy || p.items.length >= 500}
                  onPick={(t) =>
                    void save({
                      items: [...p.items, { ref: t.ref, title: t.title, artist: t.artist, duration_s: t.duration_s }],
                    })
                  }
                />
              )}
              <ul className="divide-y divide-line">
                {p.items.map((t, i) => (
                  <li key={`${i}:${t.ref}`} className="flex min-w-0 items-center gap-2 py-3">
                    <span className="w-7 shrink-0 text-sm text-dim">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-semibold">{t.title}</span>
                      <span className="text-sm text-muted">{t.artist}</span>
                    </span>
                    {p.role !== 'listener' && !p.archived && (
                      <>
                        <Button
                          small
                          disabled={busy || i === 0}
                          aria-label={`Поднять ${t.title}`}
                          onClick={() => {
                            const items = [...p.items];
                            [items[i - 1], items[i]] = [items[i], items[i - 1]];
                            void save({ items });
                          }}
                        >
                          ↑
                        </Button>
                        <Button
                          small
                          disabled={busy}
                          aria-label={`Убрать ${t.title} из плейлиста`}
                          onClick={() => void save({ items: p.items.filter((_, j) => i !== j) })}
                        >
                          ×
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">Участники</h2>
                {p.members.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3"
                  >
                    <p className="break-all text-sm">
                      {m.username} · {m.role === 'owner' ? 'Владелец' : m.role === 'editor' ? 'Редактор' : 'Слушатель'}
                    </p>
                    {p.role === 'owner' && m.role !== 'owner' && (
                      <Button small disabled={busy} onClick={() => void save({ username: m.username, role: 'remove' })}>
                        Убрать доступ
                      </Button>
                    )}
                  </div>
                ))}
                {p.role === 'owner' && !p.archived && (
                  <div className="space-y-3">
                    <Field label="Логин участника">
                      <input
                        className="input"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        maxLength={128}
                      />
                    </Field>
                    <Field label="Права">
                      <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                        <option value="listener">Слушатель</option>
                        <option value="editor">Редактор</option>
                      </select>
                    </Field>
                    <Button
                      disabled={busy || !username.trim()}
                      onClick={() => void save({ username: username.trim(), role })}
                    >
                      Добавить или изменить роль
                    </Button>
                  </div>
                )}
              </section>
              {p.role === 'owner' && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: p.archived ? 'Восстановить плейлист?' : 'Архивировать плейлист?',
                        body: 'Архив сохраняет треки и участников. Действующие общие ссылки будут отозваны.',
                        okLabel: p.archived ? 'Восстановить' : 'В архив',
                      })
                    )
                      await save({ archived: !p.archived });
                  }}
                >
                  {p.archived ? 'Восстановить' : 'В архив'}
                </Button>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

export function ResumePage() {
  const res = useAsync((s) => community<Snapshot[]>('/resume', s), []);
  return (
    <div className="pb-8">
      <PageHeader
        title="Продолжить слушать"
        back="/community"
        right={
          <Button small onClick={() => res.reload()}>
            Обновить
          </Button>
        }
      />
      <div className="space-y-4 px-4">
        <Notice kind="info">
          Сохраняются до 200 треков вокруг текущего, позиция и последние десять устройств. Новая страница сама не
          перехватывает воспроизведение.
        </Notice>
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : !res.data?.length ? (
          <Empty
            icon="play"
            title="Пока нечего продолжать"
            text="Включите музыку в браузере — очередь появится здесь."
          />
        ) : (
          res.data.map((s) => (
            <article key={s.device} className="space-y-3 rounded-xl border border-line p-4">
              <h2 className="font-semibold">{s.label}</h2>
              <p className="break-words">
                {s.queue[s.index]?.artist} — {s.queue[s.index]?.title}
              </p>
              <p className="text-sm text-muted">
                {fmtDuration(s.position)} · {s.queue.length} треков · {fmtWhen(s.updated_at)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    resumeRemote(s.queue, s.index, s.position);
                    navigate('/player');
                  }}
                >
                  Продолжить
                </Button>
                <Button
                  onClick={async () => {
                    await attempt(() => request('DELETE', '/api/community/resume/' + s.device));
                    res.reload();
                  }}
                >
                  Забыть
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

const versionKinds: Record<string, string> = {
  original: 'Оригинал',
  clean: 'Clean',
  live: 'Live',
  remix: 'Ремикс',
  acoustic: 'Акустика',
  other: 'Другая версия',
};
export function VersionsPage() {
  const { me } = useSession();
  const res = useAsync((s) => community<Group[]>('/versions', s), []);
  const [name, setName] = useState(''),
    [selected, setSelected] = useState<{ track_id: number; kind: string; title: string }[]>([]),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  return (
    <div className="pb-8">
      <PageHeader
        title="Версии треков"
        back="/community"
        right={
          <Button small onClick={() => res.reload()}>
            Обновить
          </Button>
        }
      />
      <div className="space-y-5 px-4">
        <Notice kind="info">
          Файлы остаются на месте. Личный выбор версии применяется при следующем запуске трека и не меняет очередь
          другого пользователя.
        </Notice>
        {me.is_admin && (
          <details key={editing?.id ?? 'new'} open={!!editing} className="rounded-xl border border-line bg-surface p-4">
            <summary className="cursor-pointer font-semibold">Связать версии</summary>
            <div className="mt-4 space-y-3">
              <Field label="Название группы">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={512} />
              </Field>
              <LibrarySearch
                disabled={busy || selected.length >= 20}
                onPick={(t) => {
                  if (!selected.some((m) => m.track_id === t.id))
                    setSelected((x) => [...x, { track_id: t.id, kind: 'other', title: t.title }]);
                }}
              />
              {selected.map((m) => (
                <div key={m.track_id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 break-words text-sm">{m.title}</span>
                  <select
                    aria-label={`Вид версии ${m.title}`}
                    className="input !w-auto"
                    value={m.kind}
                    onChange={(e) =>
                      setSelected((x) => x.map((v) => (v.track_id === m.track_id ? { ...v, kind: e.target.value } : v)))
                    }
                  >
                    {Object.entries(versionKinds).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Button small onClick={() => setSelected((x) => x.filter((v) => v.track_id !== m.track_id))}>
                    Убрать
                  </Button>
                </div>
              ))}
              <Button
                variant="primary"
                busy={busy}
                disabled={!name.trim() || selected.length < 2}
                onClick={async () => {
                  setBusy(true);
                  const r = await attempt(
                    () =>
                      request(
                        editing ? 'PUT' : 'POST',
                        editing ? `/api/community/versions/${editing.id}` : '/api/community/versions',
                        {
                          json: {
                            name: name.trim(),
                            members: selected.map(({ track_id, kind }) => ({ track_id, kind })),
                            ...(editing ? { revision: editing.revision } : {}),
                          },
                        },
                      ),
                    'Версии связаны',
                  );
                  setBusy(false);
                  if (r) {
                    setName('');
                    setSelected([]);
                    setEditing(null);
                    res.reload();
                  }
                }}
              >
                {editing ? 'Сохранить группу' : 'Связать без удаления файлов'}
              </Button>
              {editing && (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setName('');
                    setSelected([]);
                  }}
                >
                  Отменить редактирование
                </Button>
              )}
            </div>
          </details>
        )}
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : !res.data?.length ? (
          <Empty icon="disc" title="Групп версий пока нет" text="Администратор может связать существующие записи." />
        ) : (
          res.data.map((g) => (
            <section key={g.id} className="space-y-3 rounded-xl border border-line p-4">
              <h2 className="break-words text-lg font-semibold">{g.name}</h2>
              {me.is_admin && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    small
                    disabled={busy}
                    onClick={() => {
                      setEditing(g);
                      setName(g.name);
                      setSelected(g.members.map((m) => ({ track_id: m.track_id, kind: m.kind, title: m.title })));
                    }}
                  >
                    Изменить группу
                  </Button>
                  <Button
                    small
                    variant="danger"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: 'Убрать связь между версиями?',
                          body: 'Аудиофайлы сохранятся. Личные предпочтения этой группы будут сброшены.',
                          okLabel: 'Убрать связь',
                        })
                      ) {
                        await attempt(() => request('DELETE', `/api/community/versions/${g.id}`));
                        res.reload();
                      }
                    }}
                  >
                    Убрать связь
                  </Button>
                </div>
              )}
              {g.members.map((m) => (
                <div
                  key={m.track_id}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3"
                >
                  <span className="min-w-0">
                    <span className="block break-words font-semibold">
                      {m.artist} — {m.title}
                    </span>
                    <span className="text-xs text-muted">
                      {versionKinds[m.kind]} · {m.codec?.toUpperCase()} {m.bitrate_kbps && `· ${m.bitrate_kbps} кбит/с`}
                    </span>
                  </span>
                  <Button
                    small
                    disabled={busy || !m.ref || g.preferred_track_id === m.track_id}
                    onClick={async () => {
                      setBusy(true);
                      await attempt(() =>
                        request('PUT', `/api/community/versions/${g.id}/preference`, {
                          json: { track_id: m.track_id },
                        }),
                      );
                      setBusy(false);
                      res.reload();
                    }}
                  >
                    {g.preferred_track_id === m.track_id ? 'Выбрано' : 'Предпочитать'}
                  </Button>
                </div>
              ))}
              {g.preferred_track_id && (
                <Button
                  small
                  disabled={busy}
                  onClick={async () => {
                    await attempt(() =>
                      request('PUT', `/api/community/versions/${g.id}/preference`, { json: { track_id: null } }),
                    );
                    res.reload();
                  }}
                >
                  Сбросить личный выбор
                </Button>
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function PolicyEditor({ row, onSaved }: { row: Policy & { id: number; username: string }; onSaved: () => void }) {
  const [form, setForm] = useState({
      max_queue: row.max_queue,
      storage_mb: row.storage_mb,
      upload_mb: row.upload_mb,
      parallel: row.parallel,
    }),
    [busy, setBusy] = useState(false);
  return (
    <section className="space-y-3 rounded-xl border border-line p-4">
      <h2 className="break-all font-semibold">{row.username}</h2>
      <p className="text-sm text-muted">
        В очереди: {row.queued} · Занято: {(row.used_bytes / 1048576).toFixed(1)} МиБ
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ['max_queue', 'Заданий в очереди'],
            ['storage_mb', 'Место, МиБ'],
            ['upload_mb', 'Один файл, МиБ'],
            ['parallel', 'Параллельных скачиваний'],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              className="input"
              type="number"
              min={0}
              value={form[key]}
              onChange={(e) => setForm((x) => ({ ...x, [key]: Math.max(0, Number(e.target.value) || 0) }))}
            />
          </Field>
        ))}
      </div>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          await attempt(
            () => request('PUT', `/api/community/limits/users/${row.id}`, { json: form }),
            'Лимиты сохранены',
          );
          setBusy(false);
          onSaved();
        }}
      >
        Сохранить лимиты
      </Button>
    </section>
  );
}
export function LimitsPage() {
  const { me } = useSession();
  const own = useAsync((s) => community<Policy>('/limits', s), []);
  const users = useAsync(
    (s) => community<(Policy & { id: number; username: string })[]>('/limits/users', s),
    [],
    me.is_admin,
  );
  return (
    <div className="pb-8">
      <PageHeader title={me.is_admin ? 'Лимиты пользователей' : 'Мои лимиты'} back="/community" />
      <div className="space-y-4 px-4">
        <Notice kind="info">
          Ноль означает отсутствие дополнительного ограничения. Глобальные ограничения сервера продолжают действовать.
          Место учитывает добавленные пользователем файлы и временные загрузки за последние семь дней.
        </Notice>
        {own.data && (
          <p className="text-sm text-muted">
            Ваша очередь: {own.data.queued}
            {own.data.max_queue ? ` / ${own.data.max_queue}` : ''}. Место: {(own.data.used_bytes / 1048576).toFixed(1)}{' '}
            МиБ{own.data.storage_mb ? ` / ${own.data.storage_mb}` : ''}. Файл:{' '}
            {own.data.upload_mb ? `${own.data.upload_mb} МиБ` : 'по общим настройкам сервера'}. Параллельные скачивания:{' '}
            {own.data.parallel || 'по общим настройкам сервера'}.
          </p>
        )}
        {own.error && <ErrorState text={own.error} onRetry={() => own.reload()} />}{' '}
        {me.is_admin &&
          (users.loading ? (
            <Loading />
          ) : users.error ? (
            <ErrorState text={users.error} onRetry={() => users.reload()} />
          ) : (
            users.data?.map((u) => (
              <PolicyEditor
                key={u.id}
                row={u}
                onSaved={() => {
                  users.reload(true);
                  own.reload(true);
                }}
              />
            ))
          ))}
      </div>
    </div>
  );
}

export function SharesPage({
  collectionId,
  trackRef,
  trackTitle,
}: {
  collectionId?: string;
  trackRef?: string;
  trackTitle?: string;
}) {
  const res = useAsync((s) => community<SharedLink[]>('/shares', s), []),
    collections = useAsync((s) => community<Collection[]>('/playlists', s), []);
  const [kind, setKind] = useState<'track' | 'collection' | 'nd-playlist'>(collectionId ? 'collection' : 'track'),
    [id, setId] = useState(collectionId ?? trackRef ?? ''),
    [access, setAccess] = useState('public'),
    [hours, setHours] = useState('168'),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState('');
  const native = useAsync((s) => api.playlists(s), []);
  const copy = (url: string) =>
    attempt(async () => {
      await navigator.clipboard.writeText(new URL(url, location.origin).href);
      return true;
    }, 'Ссылка скопирована');
  return (
    <div className="pb-8">
      <PageHeader title="Общие ссылки" back="/community" />
      <div className="space-y-4 px-4">
        <Notice kind="info">
          Ссылка открывает снимок выбранных локальных треков. Личные заметки, Nextcloud и будущие добавления в плейлист
          в неё не попадают.
        </Notice>
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <Field label="Чем поделиться">
            <select
              className="input"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as typeof kind);
                setId('');
                setAccess('public');
              }}
            >
              <option value="track">Треком из библиотеки</option>
              <option value="collection">Совместным плейлистом</option>
              <option value="nd-playlist">Личным плейлистом</option>
            </select>
          </Field>
          {kind === 'track' ? (
            <>
              <LibrarySearch disabled={busy} onPick={(s) => setId(s.ref)} />
              {id && (
                <p className="text-sm text-muted">
                  {trackTitle ? 'Выбрано: ' + trackTitle : 'Трек выбран. Можно выбрать другую запись выше.'}
                </p>
              )}
            </>
          ) : (
            <Field label="Плейлист">
              <select className="input" value={id} onChange={(e) => setId(e.target.value)}>
                <option value="">Выберите плейлист</option>
                {kind === 'collection'
                  ? collections.data
                      ?.filter((c) => c.role === 'owner')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                  : native.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
              </select>
            </Field>
          )}
          <Field label="Кто может открыть">
            <select className="input" value={access} onChange={(e) => setAccess(e.target.value)}>
              <option value="public">Любой, у кого есть ссылка</option>
              {kind === 'collection' && <option value="members">Только участники плейлиста</option>}
            </select>
          </Field>
          <Field label="Срок действия">
            <select className="input" value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="1">Один час</option>
              <option value="24">Сутки</option>
              <option value="168">Неделя</option>
              <option value="720">30 дней</option>
            </select>
          </Field>
          <Button
            variant="primary"
            busy={busy}
            disabled={!id}
            onClick={async () => {
              if (
                !(await confirmDialog({
                  title: 'Создать общую ссылку?',
                  body:
                    access === 'public'
                      ? 'Любой получатель ссылки сможет слушать выбранные треки до истечения срока или отзыва.'
                      : 'Слушать смогут только текущие участники плейлиста.',
                  okLabel: 'Создать ссылку',
                }))
              )
                return;
              setBusy(true);
              const link = await attempt(() =>
                request<{ url: string }>('POST', '/api/community/shares', {
                  json: { kind, id, access, hours: Number(hours) },
                }),
              );
              setBusy(false);
              if (link) {
                setCreated(new URL(link.url, location.origin).href);
                res.reload();
              }
            }}
          >
            Создать ссылку
          </Button>
          {created && (
            <div className="space-y-2">
              <Field label="Готовая ссылка">
                <input readOnly className="input" value={created} onFocus={(e) => e.target.select()} />
              </Field>
              <Button small onClick={() => copy(created)}>
                Скопировать
              </Button>
            </div>
          )}
        </div>
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : !res.data?.length ? (
          <Empty icon="external" title="Общих ссылок пока нет" />
        ) : (
          res.data.map((s) => (
            <article key={s.id} className="space-y-2 rounded-xl border border-line p-4">
              <h2 className="break-words font-semibold">{s.name}</h2>
              <p className="text-sm text-muted">
                {s.track_count} треков ·{' '}
                {s.revoked ? 'Отозвана' : s.expired ? 'Срок истёк' : s.access === 'public' ? 'По ссылке' : 'Участникам'}{' '}
                · до {fmtDeadline(s.expires_at)}
              </p>
              {!s.revoked && !s.expired && (
                <div className="flex flex-wrap gap-2">
                  {s.url && (
                    <Button small onClick={() => copy(s.url!)}>
                      Копировать
                    </Button>
                  )}
                  <Button
                    small
                    variant="danger"
                    onClick={async () => {
                      await attempt(() => request('DELETE', `/api/community/shares/${s.id}`));
                      res.reload();
                    }}
                  >
                    Отозвать доступ
                  </Button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  );
}
