import { DeviceButton, SleepButton } from '../components/PlayerTools';
import { openPlayerTool } from '../lib/playerTools';
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { LikeButton } from '../components/LikeButton';
import { MusicTrack } from '../components/MusicTrack';
import { PlayerQueue } from '../components/PlayerQueue';
import { SeekBar, Transport, VolumeControl } from '../components/PlayerControls';
import { TrackMenuButton } from '../components/TrackMenu';
import { usePreparation } from '../components/Preparation';
import { Button, Cover, Empty, IconButton, cx } from '../components/ui';
import { useMusicSettings, type RadioMode } from '../lib/music';
import { useDesktop } from '../lib/desktop';
import { downloadRef, seek, stopListening, useListen } from '../lib/listen';
import { providerLabel } from '../lib/format';
import { Link, enc, goBack, useRoute } from '../lib/router';
import { addRec, hideRec } from '../lib/smartShuffle';
import { canWave, seedKey, startWave, trackSeed, useWave } from '../lib/wave';

export function PlayerPage() {
  const track = useListen((s) => s.track);
  const phase = useListen((s) => s.phase);
  const info = useListen((s) => s.info);
  const error = useListen((s) => s.error);
  const position = useListen((s) => s.position);
  const duration = useListen((s) => s.duration);
  const context = useListen((s) => s.context);
  const downloaded = useListen((s) => (s.track ? s.downloads.get(s.track.ref) : undefined));
  const preparing = usePreparation(track?.ref, phase === 'resolving' || phase === 'loading');
  const route = useRoute();
  const requestedPanel = route.query.get('panel');
  const [panel, setPanel] = useState<'queue' | 'lyrics'>(requestedPanel === 'lyrics' ? 'lyrics' : 'queue');
  useEffect(() => setPanel(requestedPanel === 'lyrics' ? 'lyrics' : 'queue'), [requestedPanel]);
  const [busy, setBusy] = useState(false);
  const [radioMode, setRadioMode] = useState<RadioMode | null>(null);
  const { starting } = useWave();
  const settings = useMusicSettings();
  const desktop = useDesktop();
  if (!track)
    return (
      <div className="pt-safe min-h-dvh">
        <IconButton icon="down" label="Свернуть" onClick={() => goBack('/home')} />
        <Empty
          icon="note"
          title="Сейчас ничего не играет"
          text="Выберите трек в библиотеке или найдите что-нибудь новое."
        >
          <Link to="/search" className="mt-5 rounded-full bg-accent px-6 py-3 font-semibold text-on-accent">
            Найти музыку
          </Link>
        </Empty>
      </div>
    );
  const cover = track.cover_url || track.cover_small_url;
  const owned = info?.kind === 'library';
  const source = owned
    ? 'Из вашей библиотеки'
    : info?.kind === 'full'
      ? providerLabel(info.provider)
      : info?.kind === 'preview'
        ? 'Превью · 30 секунд'
        : null;
  const status =
    phase === 'error'
      ? error
      : (preparing ?? (phase === 'resolving' ? 'Ищу файл…' : phase === 'loading' ? 'Загрузка…' : source));
  const waveSeed = trackSeed({ ...track, nd_song_id: info?.nd_song_id });
  const artist = track.artists?.find((a) => a.ref);
  const download = async () => {
    setBusy(true);
    await downloadRef(track.ref);
    setBusy(false);
  };
  return (
    <div
      className={cx(
        'player-stage pt-safe relative isolate min-h-dvh pb-safe',
        desktop ? 'left-1/2 w-[calc(100vw-24px)] -translate-x-1/2 px-8 pb-8' : 'px-5 pb-7',
      )}
    >
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[#121212]" aria-hidden="true">
        {cover && <img src={cover} alt="" className="h-full w-full scale-125 object-cover opacity-25 blur-[90px]" />}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-[#121212]/60 to-[#121212]" />
      </div>
      <header className="mx-auto flex h-20 max-w-[1160px] items-center justify-between gap-3">
        <IconButton
          icon="down"
          label="Свернуть"
          onClick={() => goBack('/home')}
          className="border border-white/10 bg-white/5"
        />
        <div className="min-w-0 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-muted">Сейчас играет</p>
          <p className="mt-1 truncate text-xs font-medium">{contextLabel(context)}</p>
        </div>
        <TrackMenuButton
          track={{ ...track, nd_song_id: info?.nd_song_id }}
          inPlayer
          extra={[
            { icon: 'timer', label: 'Таймер сна', onClick: () => openPlayerTool('sleep') },
            { icon: 'devices', label: 'Устройства и управление', onClick: () => openPlayerTool('devices') },
            { icon: 'keyboard', label: 'Горячие клавиши', onClick: () => openPlayerTool('shortcuts') },
            {
              icon: 'x',
              label: 'Закрыть плеер',
              onClick: () => {
                stopListening();
                goBack('/home');
              },
            },
          ]}
          className="border border-white/10 bg-white/5"
        />
      </header>
      <div className="mx-auto grid max-w-[1100px] items-start gap-8 pb-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,.85fr)] lg:gap-14 xl:gap-20">
        <section className="min-w-0" aria-label="Сейчас играет">
          <div className="mx-auto mt-2 w-full max-w-[min(76vw,390px)] lg:max-w-[min(44dvh,420px)]">
            <Cover
              src={cover}
              alt={track.title}
              className="player-art aspect-square w-full !rounded-2xl shadow-[0_24px_80px_#0009]"
            />
          </div>
          <div className="mx-auto mt-7 max-w-lg">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <h1
                  className="line-clamp-2 text-[26px] font-bold leading-tight tracking-tight lg:text-3xl"
                  title={track.title}
                >
                  {track.album_ref ? (
                    <Link to={`/album/${enc(track.album_ref)}`} className="hover:underline">
                      {track.title}
                    </Link>
                  ) : (
                    track.title
                  )}
                </h1>
                <p className="mt-2 truncate text-[15px] text-white/55">
                  {artist?.ref ? (
                    <Link to={`/artist/${enc(artist.ref)}`} className="hover:text-fg hover:underline">
                      {track.artist}
                    </Link>
                  ) : (
                    track.artist
                  )}
                </p>
              </div>
              <LikeButton
                songId={info?.nd_song_id}
                refId={track.ref}
                title={track.title}
                data={{ ...track }}
                size={25}
              />
            </div>
            <div className="mt-5">
              <SeekBar />
            </div>
            <div className="mt-4">
              <Transport large />
            </div>
            <p
              className={cx('mt-4 min-h-4 text-center text-xs', phase === 'error' ? 'text-danger' : 'text-muted')}
              role={phase === 'error' ? 'alert' : undefined}
            >
              {status}
              {info?.bitrate_kbps && phase === 'playing' ? ` · ${info.bitrate_kbps} кбит/с` : ''}
            </p>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[.07] pt-3">
              <div className="flex items-center gap-1">
                {owned || downloaded ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <Icon name="check" size={15} />
                    {downloaded && downloaded !== 'done' ? 'В загрузках' : 'В библиотеке'}
                  </span>
                ) : (
                  <Button small variant="ghost" icon="download" busy={busy} onClick={() => void download()}>
                    Скачать
                  </Button>
                )}
              </div>
              {desktop && (
                <div className="w-36">
                  <VolumeControl />
                </div>
              )}
              <div className="flex items-center gap-1">
                <SleepButton />
                <DeviceButton />
                <Link
                  to="/music-settings"
                  title="Музыка и звук"
                  aria-label="Музыка и звук"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-fg"
                >
                  <Icon name="sliders" size={19} />
                </Link>
              </div>
            </div>
            {track.rec && (
              <div className="mt-3 flex items-center gap-1 rounded-xl bg-white/5 py-1 pl-3 pr-1">
                <Icon name="sparkle" size={16} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 text-xs text-muted">{track.rec.label}</span>
                <IconButton icon="plus" label="Добавить рекомендацию" onClick={() => void addRec(track)} size={17} />
                <IconButton icon="minus" label="Не рекомендовать здесь" onClick={() => void hideRec(track)} size={17} />
              </div>
            )}
            {canWave() && waveSeed && (
              <details className="mt-3 rounded-xl border border-white/[.07] px-4 text-sm">
                <summary className="cursor-pointer py-3 font-medium">Моя волна по треку</summary>
                <select
                  aria-label="Знакомая музыка в радио по треку"
                  className="input mb-3"
                  value={radioMode ?? settings.radio_mode}
                  onChange={(e) => setRadioMode(e.target.value as RadioMode)}
                >
                  <option value="favorites">Больше знакомого</option>
                  <option value="normal">Баланс знакомого и нового</option>
                  <option value="discover">Больше открытий</option>
                </select>
                <Button
                  block
                  small
                  icon="wave"
                  className="mb-3"
                  disabled={starting !== null}
                  busy={starting === seedKey(waveSeed)}
                  onClick={() => void startWave(waveSeed, 'player', radioMode ?? settings.radio_mode)}
                >
                  Запустить волну
                </Button>
              </details>
            )}
          </div>
        </section>
        <aside className="player-inspector min-w-0 overflow-hidden rounded-2xl border border-white/[.08] bg-[#202020]/90 lg:mt-2">
          <div role="tablist" aria-label="Панель плеера" className="flex gap-6 border-b border-white/[.07] px-5">
            {(['queue', 'lyrics'] as const).map((value) => (
              <button
                type="button"
                key={value}
                id={`player-${value}-tab`}
                role="tab"
                aria-selected={panel === value}
                aria-controls={`player-${value}-panel`}
                onClick={() => setPanel(value)}
                className={cx(
                  'relative flex min-h-14 items-center gap-2 text-sm font-semibold transition',
                  panel === value
                    ? 'text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
                    : 'text-muted hover:text-fg',
                )}
              >
                <Icon name={value === 'queue' ? 'queue' : 'lyrics'} size={18} />
                {value === 'queue' ? 'Очередь' : 'Текст песни'}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`player-${panel}-panel`}
            aria-labelledby={`player-${panel}-tab`}
            className="min-h-[320px] lg:max-h-[calc(100dvh-190px)] lg:overflow-y-auto"
          >
            {panel === 'queue' ? (
              <PlayerQueue />
            ) : (
              <MusicTrack
                key={track.ref}
                immersive
                refId={track.ref}
                title={track.title}
                artist={track.artist}
                duration={duration}
                position={position}
                onSeek={seek}
                playedRef={info?.ref}
                resolvedKey={`${info?.kind}:${info?.provider}:${info?.page_url}:${info?.nd_song_id}`}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function contextLabel(context: string): string {
  if (context.startsWith('wave:')) return 'Моя волна';
  if (context.startsWith('mix:')) return 'Микс дня';
  return (
    (
      {
        album: 'Альбом',
        artist: 'Исполнитель',
        playlist: 'Плейлист',
        liked: 'Понравившиеся',
        search: 'Из поиска',
        queue: 'Ваша очередь',
      } as Record<string, string>
    )[context] ?? 'Ваша музыка'
  );
}
