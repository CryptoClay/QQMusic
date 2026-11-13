import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { swipeTrack } from '../lib/playbackRecovery';
import { providerLabel } from '../lib/format';
import { hasNext, next, prev, seek, stopListening, useListen } from '../lib/listen';
import { useDesktop } from '../lib/desktop';
import { STANDALONE } from '../lib/embedded';
import { Link, enc } from '../lib/router';
import { LikeButton } from './LikeButton';
import { Icon } from './Icon';
import { usePreparation } from './Preparation';
import { TrackMenuButton } from './TrackMenu';
import { MusicTrack } from './MusicTrack';
import { PlayerQueue } from './PlayerQueue';
import { PlayButton, SeekBar, Transport, VolumeControl } from './PlayerControls';
import { Cover, IconButton, Sheet, cx } from './ui';

/** One persistent player: opening its queue or lyrics never replaces the audio element. */
export function MiniPlayer() {
  const track = useListen((s) => s.track);
  const phase = useListen((s) => s.phase);
  const info = useListen((s) => s.info);
  const error = useListen((s) => s.error);
  const position = useListen((s) => s.position);
  const duration = useListen((s) => s.duration);
  const onWave = useListen((s) => s.context.startsWith('wave:'));
  const canNext = useListen((s) => hasNext(s) || (s.repeat === 'all' && !s.context.startsWith('wave:')));
  const [panel, setPanel] = useState<'queue' | 'lyrics' | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; at: number } | null>(null);
  const suppressClick = useRef(false);
  const desktop = useDesktop();
  const shown = !!track;
  const preparing = usePreparation(track?.ref, phase === 'resolving' || phase === 'loading');
  useEffect(() => {
    if (!shown) setPanel(null);
  }, [shown]);
  useLayoutEffect(() => {
    const element = box.current;
    if (!shown || !element) return;
    const publish = () => document.documentElement.style.setProperty('--player-h', `${element.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--player-h');
    };
  }, [shown, desktop]);
  if (!track) return null;
  const source =
    info?.kind === 'full'
      ? providerLabel(info.provider)
      : info?.kind === 'library'
        ? 'В библиотеке'
        : info?.kind === 'preview'
          ? 'Превью · 30 сек'
          : null;
  const status =
    phase === 'error'
      ? error
      : (preparing ?? (phase === 'resolving' ? 'Ищу файл…' : phase === 'loading' ? 'Загрузка…' : null));
  const title = (
    <>
      <Cover
        src={track.cover_small_url || track.cover_url}
        size={desktop ? 56 : 44}
        alt=""
        className="player-cover shrink-0 !rounded-lg"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-fg" title={track.title}>
          {track.title}
        </span>
        <span
          className={cx('mt-1 block truncate text-xs', phase === 'error' ? 'text-danger' : 'text-muted')}
          title={status || [track.artist, source].filter(Boolean).join(' · ')}
        >
          {status ||
            (desktop
              ? track.artist
              : info?.kind === 'preview'
                ? `Превью 30 сек · ${track.artist}`
                : [track.artist, source].filter(Boolean).join(' · '))}
        </span>
        {desktop && !status && (
          <span className="mt-1 block truncate text-[10px] font-medium uppercase tracking-[.1em] text-dim">
            {onWave ? 'Моя волна' : source}
          </span>
        )}
      </span>
    </>
  );
  const song = (
    <Link
      to={STANDALONE ? '/player' : track.album_ref ? `/album/${enc(track.album_ref)}` : '/search'}
      title="Открыть плеер"
      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg"
      style={{ touchAction: 'pan-y' }}
      onPointerDown={(e) => {
        suppressClick.current = false;
        if (e.pointerType === 'touch') gesture.current = { x: e.clientX, y: e.clientY, at: Date.now() };
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
      onPointerUp={(e) => {
        const from = gesture.current;
        gesture.current = null;
        if (!from) return;
        const direction = swipeTrack(e.clientX - from.x, e.clientY - from.y, Date.now() - from.at);
        if (!direction) return;
        suppressClick.current = true;
        if (direction === 'next') void next();
        else prev();
      }}
      onClick={(e) => {
        if (suppressClick.current) {
          e.preventDefault();
          suppressClick.current = false;
        }
      }}
    >
      {title}
    </Link>
  );
  const like = (
    <LikeButton
      songId={info?.nd_song_id}
      refId={track.ref}
      title={track.title}
      data={{ ...track }}
      className="!h-9 !w-9 shrink-0"
      size={19}
    />
  );
  const menu = (
    <TrackMenuButton
      track={{ ...track, nd_song_id: info?.nd_song_id }}
      inPlayer
      extra={[
        { icon: 'queue', label: 'Очередь воспроизведения', onClick: () => setPanel('queue') },
        { icon: 'lyrics', label: 'Текст песни', onClick: () => setPanel('lyrics') },
        { icon: 'x', label: 'Закрыть плеер', onClick: stopListening },
      ]}
      className="!h-9 !w-9 !text-muted"
    />
  );
  return (
    <>
      <div
        ref={box}
        role="region"
        aria-label="Прослушивание"
        className={
          desktop
            ? 'fixed bottom-0 left-[238px] right-0 z-40 px-4 pb-3'
            : 'fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-40 mx-auto max-w-2xl px-2 pb-2'
        }
      >
        <div
          className={cx(
            'player-dock anim-up border border-white/[.08] bg-[#1c1c1e]/95 shadow-2xl backdrop-blur-xl',
            desktop
              ? 'grid grid-cols-[minmax(150px,1fr)_minmax(270px,1.5fr)_minmax(185px,1fr)] items-center gap-4 rounded-2xl px-4 py-3'
              : 'overflow-hidden rounded-2xl',
          )}
        >
          {desktop ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                {song}
                {like}
              </div>
              <div className="min-w-0 space-y-1">
                <Transport />
                <SeekBar compact />
              </div>
              <div className="flex items-center justify-end gap-0.5">
                <div className="w-9 min-[1280px]:w-28">
                  <span className="min-[1280px]:hidden">
                    <VolumeControl slider={false} />
                  </span>
                  <span className="hidden min-[1280px]:block">
                    <VolumeControl />
                  </span>
                </div>
                <IconButton
                  icon="lyrics"
                  label="Текст песни"
                  aria-pressed={panel === 'lyrics'}
                  onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}
                  className={cx('!h-9 !w-9', panel === 'lyrics' ? '!text-accent' : '!text-muted')}
                  size={18}
                />
                <IconButton
                  icon="queue"
                  label="Очередь воспроизведения"
                  aria-pressed={panel === 'queue'}
                  onClick={() => setPanel(panel === 'queue' ? null : 'queue')}
                  className={cx('!h-9 !w-9', panel === 'queue' ? '!text-accent' : '!text-muted')}
                  size={19}
                />
                {menu}
                <Link
                  to="/player"
                  title="Большой плеер"
                  aria-label="Большой плеер"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-fg"
                >
                  <Icon name="expand" size={17} />
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-2.5">
                {song}
                {like}
                <PlayButton />
                <span className="hidden min-[360px]:inline-flex">
                  <IconButton
                    icon="next"
                    label="Следующий трек"
                    onClick={() => void next()}
                    disabled={!canNext}
                    className="!h-9 !w-9"
                    size={21}
                  />
                </span>
                {menu}
              </div>
              <div className="px-3 pb-1">
                <SeekBar compact />
              </div>
            </>
          )}
        </div>
      </div>
      <Sheet
        open={panel !== null}
        onClose={() => setPanel(null)}
        title={panel === 'queue' ? 'Очередь воспроизведения' : 'Текст песни'}
      >
        {panel === 'queue' ? (
          <PlayerQueue />
        ) : panel === 'lyrics' ? (
          <MusicTrack
            key={track.ref}
            refId={track.ref}
            title={track.title}
            artist={track.artist}
            position={position}
            duration={duration}
            onSeek={seek}
            playedRef={info?.ref}
            resolvedKey={`${info?.kind}:${info?.provider}:${info?.nd_song_id}`}
          />
        ) : null}
      </Sheet>
    </>
  );
}

export function PlayerSpacer() {
  const shown = useListen((s) => !!s.track);
  return shown ? <div aria-hidden="true" style={{ height: 'var(--player-h, 0px)' }} /> : null;
}
