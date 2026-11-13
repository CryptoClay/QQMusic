import { newUuid } from '../lib/uuid';
import { useEffect, useState } from 'react';
import { request, withQuery } from '../api/client';
import { useAsync, useDebounced, useInterval } from '../lib/hooks';
import { fmtDuration } from '../lib/format';
import { getListenState, pause, useListen } from '../lib/listen';
import { remoteDevice, remoteName, setRemoteAccess, useRemoteAccess, type PlayerDevice } from '../lib/remotePlayer';
import { cancelSleep, scheduleSleep, useSleep } from '../lib/sleep';
import { openPlayerTool, usePlayerTool } from '../lib/playerTools';
import { attempt } from '../lib/ui';
import { Button, Empty, ErrorState, Field, IconButton, Notice, Sheet, cx } from './ui';
import type { Song } from '../lib/community';

export function DeviceButton() {
  return (
    <IconButton
      icon="devices"
      label="Устройства и управление"
      size={19}
      className="!h-9 !w-9 !text-muted"
      onClick={() => openPlayerTool('devices')}
    />
  );
}
export function SleepButton() {
  const state = useSleep();
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), state.mode === 'time' ? 1000 : null);
  const label =
    state.mode === 'off'
      ? 'Таймер сна'
      : state.mode === 'track'
        ? 'Таймер: до конца трека'
        : `Таймер: ${fmtDuration(Math.max(0, (state.deadline - now) / 1000))}`;
  return (
    <IconButton
      icon="timer"
      label={label}
      aria-pressed={state.mode !== 'off'}
      size={19}
      className={cx('!h-9 !w-9', state.mode !== 'off' ? '!text-accent' : '!text-muted')}
      onClick={() => openPlayerTool('sleep')}
    />
  );
}
export function PlayerToolSheets() {
  const tool = usePlayerTool();
  useEffect(() => () => openPlayerTool(null), []);
  return (
    <>
      <Sheet open={tool === 'sleep'} onClose={() => openPlayerTool(null)} title="Таймер сна">
        {tool === 'sleep' && <SleepOptions />}
      </Sheet>
      <Sheet open={tool === 'devices'} onClose={() => openPlayerTool(null)} title="Где слушаем?">
        {tool === 'devices' && <DeviceControls />}
      </Sheet>
      <Sheet open={tool === 'shortcuts'} onClose={() => openPlayerTool(null)} title="Горячие клавиши">
        {tool === 'shortcuts' && (
          <div className="space-y-3 py-2 text-sm">
            <p className="mb-4 text-muted">
              Работают в этом браузере. В полях ввода, меню и на кнопках сохраняется обычное управление.
            </p>
            {[
              ['Пробел / K', 'Слушать / пауза'],
              ['← / →', 'Перемотка на 5 секунд'],
              ['↑ / ↓', 'Громкость ±5%'],
              ['N / P', 'Следующий / предыдущий трек'],
              ['L', 'Поставить или убрать лайк'],
            ].map(([key, label]) => (
              <div className="flex items-center justify-between gap-4" key={key}>
                <span>{label}</span>
                <kbd className="shrink-0 rounded-lg border border-line bg-raised px-3 py-1.5 font-mono text-xs">
                  {key}
                </kbd>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}
function SleepOptions() {
  const state = useSleep();
  const track = useListen((s) => s.track);
  return (
    <div className="space-y-3 py-2">
      <p className="text-sm text-muted">Остановит плеер в этом браузере. Очередь и позиция сохранятся.</p>
      {state.mode !== 'off' && (
        <Notice kind="info">
          {state.mode === 'track'
            ? 'Остановимся после текущего трека'
            : `Остановимся в ${new Date(state.deadline).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-2">
        {[15, 30, 45, 60].map((minutes) => (
          <Button
            key={minutes}
            disabled={!track}
            onClick={() => {
              scheduleSleep(minutes, track!.ref);
              openPlayerTool(null);
            }}
          >
            {minutes} минут
          </Button>
        ))}
      </div>
      <Button
        block
        disabled={!track}
        onClick={() => {
          scheduleSleep(0, track!.ref);
          openPlayerTool(null);
        }}
      >
        После текущего трека
      </Button>
      {state.mode !== 'off' && (
        <Button
          block
          variant="ghost"
          onClick={() => {
            cancelSleep();
            openPlayerTool(null);
          }}
        >
          Выключить таймер
        </Button>
      )}
      {!track && <p className="text-sm text-muted">Сначала выберите трек.</p>}
    </div>
  );
}
interface CommandStatus {
  id: number;
  status: string;
  result?: string | null;
}
function DeviceControls() {
  const res = useAsync((s) => request<PlayerDevice[]>('GET', '/api/player/devices', { signal: s }), []);
  const allowed = useRemoteAccess();
  const [label, setLabel] = useState(remoteName);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<CommandStatus | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 350);
  const [volume, setVolume] = useState(100);
  const [position, setPosition] = useState(0);
  const device = res.data?.find((d) => d.device === selected);
  const canControl = !!device?.enabled && !!device.online;
  type LibraryTrack = {
    id: number;
    nd_song_id: string | null;
    title: string;
    artist: string;
    duration_s: number | null;
  };
  const found = useAsync(
    (s) =>
      request<{ tracks: LibraryTrack[] }>('GET', withQuery('/api/search/library', { q, limit: 10, available: true }), {
        signal: s,
      }),
    [q, selected],
    !!selected && q.length >= 2,
  );
  useInterval(() => res.reload(true), 3000);
  useEffect(() => {
    if (device) {
      setVolume(Math.round(device.state.volume * 100));
      setPosition(device.state.position);
    }
  }, [selected]);
  useEffect(() => {
    if (!last || !['pending', 'delivered'].includes(last.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () =>
        void request<{ status: string; result: string | null }>('GET', `/api/player/commands/${last.id}`, {
          signal: controller.signal,
        })
          .then((result) => setLast({ id: last.id, ...result }))
          .catch(() => {
            if (!controller.signal.aborted) setLast({ ...last });
          }),
      1000,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [last]);
  const send = async (action: string, payload: object = {}) => {
    if (!canControl || busy) return false;
    setBusy(true);
    const result = await attempt(() =>
      request<CommandStatus>('POST', `/api/player/devices/${selected}/commands`, {
        json: { request_id: newUuid(), action, ...payload },
      }),
    );
    setBusy(false);
    if (result) {
      setLast(result);
      res.reload(true);
      return true;
    }
    return false;
  };
  const load = async (queue: Song[], index = 0, at = 0) => {
    if (await send('load', { queue, index, position: at })) pause();
  };
  return (
    <div className="space-y-5 py-1">
      <section className="rounded-xl border border-line bg-white/[.025] p-4">
        <h3 className="font-semibold">Этот браузер</h3>
        <Field label="Название плеера">
          <input
            className="input mt-2"
            value={label}
            maxLength={100}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => setRemoteAccess(allowed, label)}
          />
        </Field>
        <label className="mt-3 flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={allowed}
            onChange={(e) => {
              setRemoteAccess(e.target.checked, label);
              res.reload(true);
            }}
          />
          Разрешить управление с моих устройств
        </label>
        <p className="mt-2 text-xs text-muted">
          Только ваш аккаунт. Разрешение действует до обновления или закрытия этой вкладки.
        </p>
      </section>
      {res.error && <ErrorState text={res.error} onRetry={() => res.reload()} />}
      <section>
        <h3 className="mb-3 font-semibold">Другие плееры</h3>
        <div className="space-y-2">
          {res.data
            ?.filter((d) => d.device !== remoteDevice)
            .map((d) => (
              <button
                key={d.device}
                type="button"
                aria-pressed={selected === d.device}
                onClick={() => {
                  setSelected(d.device);
                  setLast(null);
                  setQuery('');
                }}
                className={cx(
                  'flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left',
                  selected === d.device ? 'border-accent bg-accent/10' : 'border-line hover:bg-hover',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{d.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {d.online ? (d.enabled ? 'Можно управлять' : 'Управление выключено') : 'Не в сети'}
                    {d.state.track ? ` · ${d.state.track.title}` : ''}
                  </span>
                </span>
                <span className={cx('h-2 w-2 shrink-0 rounded-full', d.online && d.enabled ? 'bg-accent' : 'bg-dim')} />
              </button>
            ))}
        </div>
        {res.data && !res.data.some((d) => d.device !== remoteDevice) && (
          <Empty
            icon="devices"
            title="Пока только этот плеер"
            text="Войдите в тот же аккаунт на компьютере или телефоне и разрешите управление в меню устройств."
          />
        )}
      </section>
      {device && (
        <section className="space-y-4 rounded-xl border border-line p-4">
          <div>
            <p className="text-xs text-accent">УПРАВЛЕНИЕ · {device.name}</p>
            <h3 className="mt-2 break-words font-semibold">{device.state.track?.title || 'Музыка пока не выбрана'}</h3>
            <p className="text-sm text-muted">{device.state.track?.artist}</p>
            <p className="mt-1 text-xs text-muted">
              {device.state.phase === 'playing'
                ? 'Играет'
                : device.state.phase === 'paused'
                  ? 'На паузе'
                  : device.state.phase === 'loading' || device.state.phase === 'resolving'
                    ? 'Загружается'
                    : device.state.phase === 'error'
                      ? 'Ошибка воспроизведения'
                      : 'Ожидает'}{' '}
              · {fmtDuration(device.state.position) || '0:00'}
            </p>
          </div>
          {!canControl && (
            <Notice>
              Откройте этот плеер и включите управление. Для воспроизведения вкладка должна оставаться открытой.
            </Notice>
          )}
          <div className="flex items-center justify-center gap-3">
            <IconButton
              icon="prev"
              label="Предыдущий на устройстве"
              disabled={!canControl || busy}
              onClick={() => void send('prev')}
            />
            <Button
              variant="primary"
              disabled={!canControl || busy}
              onClick={() => void send(device.state.phase === 'playing' ? 'pause' : 'play')}
            >
              {device.state.phase === 'playing' ? 'Пауза' : 'Слушать'}
            </Button>
            <IconButton
              icon="next"
              label="Следующий на устройстве"
              disabled={!canControl || busy}
              onClick={() => void send('next')}
            />
          </div>
          <Field label="Громкость на устройстве">
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              disabled={!canControl || busy}
              className="qqmusic-range w-full"
              onChange={(e) => setVolume(Number(e.target.value))}
              onPointerUp={() => void send('volume', { value: volume / 100 })}
              onKeyUp={() => void send('volume', { value: volume / 100 })}
            />
          </Field>
          {!!device.state.duration && (
            <Field label="Перемотка на устройстве">
              <input
                type="range"
                min={0}
                max={device.state.duration}
                value={Math.min(position, device.state.duration)}
                disabled={!canControl || busy}
                className="qqmusic-range w-full"
                onChange={(e) => setPosition(Number(e.target.value))}
                onPointerUp={() => void send('seek', { value: position, expected_ref: device.state.track?.ref })}
                onKeyUp={() => void send('seek', { value: position, expected_ref: device.state.track?.ref })}
              />
            </Field>
          )}
          <Button
            small
            block
            disabled={!canControl || busy || !getListenState().queue.length}
            onClick={() => {
              const s = getListenState();
              const start = Math.max(0, s.index - 25);
              void load(
                s.queue
                  .slice(start, start + 200)
                  .map((t) => ({ ref: t.ref, title: t.title, artist: t.artist, duration_s: t.duration_s })),
                s.index - start,
                s.position,
              );
            }}
          >
            Передать сюда мою очередь
          </Button>
          <Field label="Найти музыку для этого устройства">
            <input
              type="search"
              className="input"
              value={query}
              maxLength={512}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Исполнитель или трек из библиотеки"
            />
          </Field>
          {found.error && <p className="text-sm text-danger">{found.error}</p>}
          {q.length >= 2 &&
            found.data?.tracks.map((t) => (
              <button
                type="button"
                key={t.id}
                disabled={!canControl || busy || !t.nd_song_id}
                onClick={() =>
                  void load([{ ref: `nd:${t.nd_song_id}`, title: t.title, artist: t.artist, duration_s: t.duration_s }])
                }
                className="flex min-h-12 w-full items-center justify-between gap-3 border-t border-line py-2 text-left text-sm disabled:opacity-40"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{t.title}</span>
                  <span className="block truncate text-xs text-muted">{t.artist}</span>
                </span>
                <span className="text-accent">▶</span>
              </button>
            ))}
          {last && (
            <Notice kind={last.status === 'failed' || last.status === 'blocked' ? 'warn' : 'info'}>
              {last.result ||
                (last.status === 'expired'
                  ? 'Устройство не подтвердило команду вовремя'
                  : last.status === 'done'
                    ? 'Команда выполнена'
                    : 'Команда отправлена, ждём устройство…')}
            </Notice>
          )}
        </section>
      )}
    </div>
  );
}
