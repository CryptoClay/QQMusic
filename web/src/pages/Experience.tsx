import { useEffect, useState } from 'react';
import { request } from '../api/client';
import { Button, ErrorState, PageHeader, SectionTitle, Spinner } from '../components/ui';
import { useAsync } from '../lib/hooks';
import { Link, navigate } from '../lib/router';
import { resumeRemote } from '../lib/listen';
import type { Snapshot } from '../lib/community';
import { fmtDuration, fmtSize, fmtWhen, plural } from '../lib/format';
import { useHubEvent } from '../lib/events';
import { attempt } from '../lib/ui';
import { usePwaInstall } from '../lib/pwa';

interface PersonalHome {
  welcome_done: boolean;
  resume: Snapshot | null;
  playlists: { id: number; name: string; count: number }[];
  requests_pending: number;
}
const loadHome = (signal: AbortSignal) => request<PersonalHome>('GET', '/api/experience/home', { signal });

export function WelcomePage() {
  const [busy, setBusy] = useState(false);
  const finish = async (to: string) => {
    setBusy(true);
    const ok = await attempt(() => request('PUT', '/api/experience/welcome'));
    setBusy(false);
    if (ok) navigate(to);
  };
  return (
    <div className="pb-6">
      <PageHeader title="Добро пожаловать в QQMusic" back="/home" />
      <div className="mx-4 rounded-2xl border border-line bg-surface p-5">
        <h2 className="text-xl font-semibold">Ваша музыка, общая библиотека</h2>
        <p className="mt-2 text-sm text-muted">
          Лайки, история и предпочтения принадлежат вашему аккаунту. Музыка в библиотеке доступна слушателям сервера.
        </p>
        <ol className="my-5 space-y-4 text-sm">
          <li>
            <strong>1. Найдите любимых исполнителей.</strong>
            <p className="text-muted">Выберите 3–5 артистов, чтобы начать персональные подборки.</p>
          </li>
          <li>
            <strong>2. Запустите музыку.</strong>
            <p className="text-muted">Ищите в каталоге или слушайте готовые файлы из вкладки «Библиотека» в поиске.</p>
          </li>
          <li>
            <strong>3. Слушайте вместе.</strong>
            <p className="text-muted">Создавайте совместные плейлисты и оставляйте заявки на недостающую музыку.</p>
          </li>
        </ol>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" busy={busy} onClick={() => void finish('/taste')}>
            Выбрать исполнителей
          </Button>
          <Button disabled={busy} onClick={() => void finish('/home')}>
            Начать слушать
          </Button>
        </div>
        <p className="mt-4 text-sm">
          <Link to="/install" className="text-accent underline">
            Установка на телефон и управление с экрана блокировки
          </Link>
        </p>
      </div>
    </div>
  );
}

export function PersonalHomeSections() {
  const res = useAsync(loadHome, []);
  useHubEvent('community', () => res.reload(true));
  useEffect(() => {
    const wake = () => res.reload(true);
    window.addEventListener('focus', wake);
    return () => window.removeEventListener('focus', wake);
  }, [res.reload]);
  const d = res.data;
  if (!d)
    return res.error ? (
      <div className="px-4">
        <ErrorState text="Не удалось загрузить ваши устройства и плейлисты" onRetry={() => res.reload()} />
      </div>
    ) : null;
  const current = d.resume?.queue[d.resume.index];
  return (
    <>
      {!d.welcome_done && (
        <div className="mx-4 mt-4 rounded-xl border border-accent/40 bg-accent/10 p-4">
          <h2 className="font-semibold">С чего начать?</h2>
          <p className="mt-1 text-sm text-muted">Настройте любимых исполнителей и познакомьтесь с сервисом.</p>
          <Link className="mt-3 inline-block text-accent underline" to="/welcome">
            Знакомство с QQMusic
          </Link>
        </div>
      )}
      {d.resume && current && (
        <section
          className="mx-4 mt-4 rounded-xl border border-line bg-surface p-4"
          aria-label="Продолжить прослушивание"
        >
          <p className="text-xs text-muted">
            {d.resume.label} · {fmtWhen(d.resume.updated_at)}
          </p>
          <h2 className="mt-1 truncate font-semibold">
            {current.artist} — {current.title}
          </h2>
          <p className="text-sm text-muted">
            {fmtDuration(d.resume.position)} · {d.resume.queue.length}{' '}
            {plural(d.resume.queue.length, ['трек', 'трека', 'треков'])} в очереди
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Button
              variant="primary"
              onClick={() => {
                resumeRemote(d.resume!.queue, d.resume!.index, d.resume!.position);
                navigate('/player');
              }}
            >
              Продолжить
            </Button>
            <Link to="/resume" className="text-sm text-muted underline">
              Все устройства
            </Link>
          </div>
        </section>
      )}
      {!!d.playlists.length && (
        <section>
          <SectionTitle
            right={
              <Link to="/community-playlists" className="text-sm text-muted">
                Все
              </Link>
            }
          >
            Слушаете вместе
          </SectionTitle>
          <div className="grid gap-2 px-4 sm:grid-cols-2 lg:grid-cols-3">
            {d.playlists.map((p) => (
              <Link
                key={p.id}
                to={`/community-playlist/${p.id}`}
                className="min-w-0 rounded-xl border border-line bg-surface p-4 hover:bg-hover"
              >
                <span className="block truncate font-semibold">{p.name}</span>
                <span className="text-xs text-muted">
                  {p.count} {plural(p.count, ['трек', 'трека', 'треков'])}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {!!d.requests_pending && (
        <p className="px-4 pt-4 text-sm text-muted">
          <Link className="underline" to="/requests">
            Ваши заявки в работе: {d.requests_pending}
          </Link>
        </p>
      )}
    </>
  );
}

export function InstallPage() {
  const { canInstall, installed, install } = usePwaInstall();
  return (
    <div className="pb-6">
      <PageHeader title="QQMusic на телефоне" back="/more" />
      <div className="mx-4 space-y-5 rounded-xl border border-line bg-surface p-5 text-sm">
        <section>
          <h2 className="text-lg font-semibold">На домашнем экране</h2>
          <p className="mt-2 text-muted">
            Открывайте сервер по HTTPS. На компьютере для разработки подходит localhost.
          </p>
          {installed ? (
            <p className="mt-3 text-accent">Приложение уже открыто в отдельном окне.</p>
          ) : canInstall ? (
            <Button className="mt-3" variant="primary" onClick={() => void install()}>
              Установить QQMusic
            </Button>
          ) : (
            <p className="mt-3">
              Android и компьютер: меню браузера → «Установить приложение» или «Добавить на главный экран». iPhone и
              iPad: Safari → «Поделиться» → «На экран Домой».
            </p>
          )}
        </section>
        <section>
          <h2 className="font-semibold">Управление без открытой вкладки</h2>
          <p className="mt-2 text-muted">
            Сначала запустите трек нажатием в плеере. Поддерживаемые браузеры покажут обложку, паузу, переключение
            треков и перемотку на экране блокировки. Доступность зависит от браузера и настроек энергосбережения
            телефона.
          </p>
        </section>
        <section>
          <h2 className="font-semibold">Жесты в мини-плеере</h2>
          <p className="mt-2 text-muted">
            Проведите по названию влево — следующий трек, вправо — предыдущий. Нажмите на название, чтобы открыть полный
            плеер и очередь.
          </p>
        </section>
        <section>
          <h2 className="font-semibold">Если пропала сеть</h2>
          <p className="mt-2 text-muted">
            Очередь и позиция сохраняются. Для получения аудио нужен доступ к серверу. После восстановления связи
            активный поток попробует продолжить воспроизведение; поставить его на паузу можно в любой момент.
          </p>
        </section>
      </div>
    </div>
  );
}

interface ServerOverview {
  navidrome: boolean;
  disks: { name: string; total: number | null; used: number | null; free: number | null }[];
  downloads: Record<string, number>;
  jobs: Record<string, number>;
  active: number;
  sources: {
    name: string;
    search?: { ok: boolean; at: string };
    audio?: { ok: boolean; at: string };
    last_issue?: { reason: string; at: string };
  }[];
  failures: { id: number; title: string; artist: string; reason: string; updated_at: string }[];
}
const reasons: Record<string, string> = {
  session: 'Нужна действующая сессия источника',
  login: 'Источник требует проверку входа',
  forbidden: 'Источник отказал в доступе',
  limited: 'Источник ограничил запросы',
  tls: 'Ошибка защищённого соединения',
  unavailable: 'Источник или файл недоступен',
};
export function ServerPage() {
  const res = useAsync((s) => request<ServerOverview>('GET', '/api/experience/server', { signal: s }), []);
  useHubEvent('download', () => res.reload(true));
  useEffect(() => {
    const timer = window.setInterval(() => res.reload(true), 30000);
    return () => window.clearInterval(timer);
  }, [res.reload]);
  const d = res.data;
  return (
    <div className="pb-6">
      <PageHeader
        title="Состояние сервера"
        back="/more"
        right={
          <Button small onClick={() => res.reload(true)}>
            Обновить
          </Button>
        }
      />
      {res.loading && !d ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : res.error ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : (
        d && (
          <>
            <p className="px-4 pb-4 text-sm text-muted">
              Hub отвечает · Navidrome: {d.navidrome ? 'доступен' : 'не отвечает'}
            </p>
            <div className="grid gap-3 px-4 sm:grid-cols-2">
              {d.disks.map((disk) => (
                <section key={disk.name} className="rounded-xl border border-line bg-surface p-4">
                  <h2 className="font-semibold">{disk.name}</h2>
                  <p className="mt-2 text-sm text-muted">
                    {disk.free === null
                      ? 'Не удалось прочитать состояние диска'
                      : `Свободно ${fmtSize(disk.free)} из ${fmtSize(disk.total!)}`}
                  </p>
                  {!!disk.total && (
                    <progress
                      aria-label={`Занято: ${disk.name}`}
                      className="mt-3 h-2 w-full accent-accent"
                      value={disk.used!}
                      max={disk.total}
                    />
                  )}
                  {disk.free !== null && disk.total && disk.free / disk.total < 0.1 ? (
                    <p className="mt-2 text-sm text-warn">Осталось менее 10% свободного места</p>
                  ) : null}
                </section>
              ))}
            </div>
            <SectionTitle>Очередь и задания</SectionTitle>
            <div className="mx-4 rounded-xl bg-surface p-4 text-sm">
              <p>
                Незавершённых загрузок: <strong>{d.active}</strong>
              </p>
              <p className="mt-2 text-muted">
                Заданий в очереди: {d.jobs.queued ?? 0} · выполняются: {d.jobs.running ?? 0} · с ошибкой:{' '}
                {d.jobs.failed ?? 0}
              </p>
              <Link to="/downloads" className="mt-3 inline-block text-accent underline">
                Открыть загрузки
              </Link>
            </div>
            <SectionTitle
              right={
                <Link to="/sources" className="text-sm text-accent">
                  Проверить источники
                </Link>
              }
            >
              Источники
            </SectionTitle>
            <div className="grid gap-2 px-4 sm:grid-cols-2">
              {d.sources.map((source) => (
                <section className="rounded-xl bg-surface p-4 text-sm" key={source.name}>
                  <h3 className="font-semibold">{source.name}</h3>
                  <p className="mt-1 text-muted">
                    Поиск:{' '}
                    {source.search ? (source.search.ok ? 'последняя проверка успешна' : 'ошибка') : 'нет наблюдений'}
                  </p>
                  <p className="text-muted">
                    Аудио: {source.audio ? (source.audio.ok ? 'последний запрос успешен' : 'ошибка') : 'нет наблюдений'}
                  </p>
                  {source.last_issue && (
                    <p className="mt-2 text-warn">
                      {reasons[source.last_issue.reason] ?? 'Ошибка источника'} · {fmtWhen(source.last_issue.at)}
                    </p>
                  )}
                </section>
              ))}
            </div>
            <p className="px-4 pt-2 text-xs text-muted">
              Показываются наблюдения с последнего запуска Hub. Эта страница не отправляет поисковые запросы источникам.
            </p>
            <SectionTitle>Последние неудачные загрузки</SectionTitle>
            <ul className="mx-4 divide-y divide-line rounded-xl bg-surface">
              {d.failures.map((f) => (
                <li key={f.id} className="p-4 text-sm">
                  <p className="font-semibold">
                    {f.artist} — {f.title}
                  </p>
                  <p className="text-muted">
                    {reasons[f.reason]} · {fmtWhen(f.updated_at)}
                  </p>
                </li>
              ))}
            </ul>
            {!d.failures.length && <p className="px-4 text-sm text-muted">Загрузок с ошибками нет.</p>}
          </>
        )
      )}
    </div>
  );
}
