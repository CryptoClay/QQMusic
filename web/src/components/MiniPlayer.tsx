import { swipeTrack } from '../lib/playbackRecovery';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { fmtDuration, providerLabel } from '../lib/format';
import { downloadRef, hasNext, hasPrev, next, prev, seek, setVolume, stopListening, toggle, useListen } from '../lib/listen';
import { useDesktop } from '../lib/desktop';
import { STANDALONE } from '../lib/embedded';
import { addRec, hideRec } from '../lib/smartShuffle';
import { Link, enc } from '../lib/router';
import { Icon } from './Icon';
import { LikeButton } from './LikeButton';
import { usePreparation } from './Preparation';
import { TrackMenuButton } from './TrackMenu';
import { Cover, IconButton, Spinner, cx } from './ui';

/** Listening to a catalog track before downloading it: sits above the tab bar (inside the app: at the bottom of
 * the Hub page, which the app keeps above its own player). Publishes its height as `--player-h`.
 * ♥ stars the song (a track that isn't downloaded is downloaded first); ⏮/⏭ move through the list it was
 * started from («Моя волна» — 〜 before the artist: the list goes on by itself, `lib/wave.ts`). In a plain browser
 * a tap on the track opens the full player with the queue (`/player`); inside the app — the album. */
export function MiniPlayer() {
  const track = useListen((s) => s.track);
  const phase = useListen((s) => s.phase);
  const info = useListen((s) => s.info);
  const error = useListen((s) => s.error);
  const position = useListen((s) => s.position);
  const duration = useListen((s) => s.duration);
  const volume = useListen((s) => s.volume);
  const dl = useListen((s) => (s.track ? s.downloads.get(s.track.ref) : undefined));
  const canNext = useListen((s) => hasNext(s) || (s.repeat === 'all' && !s.context.startsWith('wave:')));
  const canPrev = useListen(hasPrev);
  const onWave = useListen((s) => s.context.startsWith('wave:'));
  const [busy, setBusy] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gesture = useRef<{x: number; y: number; at: number} | null>(null);
  const suppressClick = useRef(false);
  const desktop = useDesktop();
  const shown = !!track;
  const preparing = usePreparation(track?.ref, phase === 'resolving' || phase === 'loading');


  useLayoutEffect(() => {
    const el = box.current;
    const root = document.documentElement;
    if (!shown || !el) return;
    const publish = () => root.style.setProperty('--player-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--player-h');
    };
  }, [shown]);

  if (!track) return null;

  const waiting = phase === 'resolving' || phase === 'loading';
  const playing = phase === 'playing' || waiting;
  const owned = info?.kind === 'library';
  const status =
    phase === 'error'
      ? error
      : preparing ? preparing : phase === 'resolving' && !info
        ? 'Ищу файл…'
        : waiting
          ? 'Загрузка…'
          : null;
  const source = info?.kind === 'full' ? providerLabel(info.provider) : owned ? 'из библиотеки' : null;
  const shownPos = scrub ?? Math.min(position, duration || position);
  const pct = duration ? Math.min(100, (shownPos / duration) * 100) : 0;
  const commit = () => {
    if (scrub !== null) seek(scrub);
    setScrub(null);
  };

  const download = async () => {
    setBusy(true);
    await downloadRef(track.ref);
    setBusy(false);
  };

  const head = (
    <>
      <Cover src={track.cover_small_url || track.cover_url} size={44} alt="" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium leading-tight">{track.title}</div>
        {status ? (
          <div className={cx('text-[13px] leading-tight', phase === 'error' ? 'line-clamp-2 text-danger' : 'truncate text-muted')}>{status}</div>
        ) : (
          <div className="flex items-center gap-1.5 text-[13px] leading-tight text-muted">
            {onWave && (
              <span title="Моя волна" className="shrink-0 text-accent">
                <Icon name="wave" size={14} />
              </span>
            )}
            {track.rec && (
              <span title={track.rec.label} className="shrink-0 text-accent">
                <Icon name="sparkle" size={14} />
              </span>
            )}
            {info?.kind === 'preview' && <span className="shrink-0 rounded bg-warn/15 px-1 text-[11px] font-semibold text-warn">превью 30 сек</span>}
            <span className="truncate">{[track.artist, source].filter(Boolean).join(' · ')}</span>
          </div>
        )}
      </div>
    </>
  );

  return (
    <div ref={box} className={desktop ? 'fixed bottom-0 left-[238px] right-0 z-40 px-4 pb-3' : 'fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-40 mx-auto max-w-2xl px-2 pb-2'} role="region" aria-label="Прослушивание">
      <div className={desktop ? 'anim-up mx-auto max-w-[1152px] overflow-hidden rounded-2xl border border-[#3b3938] bg-[#202022]/[.98] shadow-2xl backdrop-blur' : 'anim-up overflow-hidden rounded-xl border border-line bg-raised/95 shadow-2xl backdrop-blur'}>
        <div className="flex items-center gap-2 py-1.5 pl-2 pr-1">
          {STANDALONE ? (
            <Link to="/player" className="flex min-w-0 flex-1 items-center gap-3" title="Открыть плеер"
              style={{ touchAction: 'pan-y' }}
              onPointerDown={e => { suppressClick.current = false; if (e.pointerType === 'touch') gesture.current = { x: e.clientX, y: e.clientY, at: Date.now() }; }}
              onPointerCancel={() => { gesture.current = null; }}
              onPointerUp={e => {
                const from = gesture.current; gesture.current = null;
                if (!from) return;
                const direction = swipeTrack(e.clientX - from.x, e.clientY - from.y, Date.now() - from.at);
                if (!direction) return;
                suppressClick.current = true;
                if (direction === 'next') void next(); else prev();
              }}
              onClick={e => { if (suppressClick.current) { e.preventDefault(); suppressClick.current = false; } }}>
              {head}
            </Link>
          ) : track.album_ref ? (
            <Link to={`/album/${enc(track.album_ref)}`} className="flex min-w-0 flex-1 items-center gap-3" title="Открыть альбом">
              {head}
            </Link>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-3">{head}</div>
          )}
          {STANDALONE && (
            <div className="hidden w-36 shrink-0 items-center gap-1.5 text-muted md:flex">
              <Icon name="volume" size={18} className="shrink-0" />
              <input type="range" className="qqmusic-range min-w-0 flex-1" aria-label="Громкость"
                aria-valuetext={`${Math.round(volume * 100)}%`}
                min={0} max={100} step={1} value={Math.round(volume * 100)}
                style={{ '--p': `${volume * 100}%` } as CSSProperties}
                onChange={(e) => setVolume(Number(e.target.value) / 100)} />
            </div>
          )}
          <TrackMenuButton track={{ ...track, nd_song_id: info?.nd_song_id }} className="w-9" inPlayer />
          <LikeButton songId={info?.nd_song_id} refId={track.ref} title={track.title} data={{ ...track }} className="-mr-1" />
          <button
            type="button"
            onClick={toggle}
            aria-label={phase === 'error' ? 'Повторить' : playing ? 'Пауза' : 'Слушать'}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fg text-bg transition active:scale-95"
          >
            {phase === 'error' ? (
              <Icon name="refresh" size={20} stroke={2.4} />
            ) : waiting ? (
              <Spinner size={20} />
            ) : playing ? (
              <Icon name="pause" size={20} stroke={3} />
            ) : (
              <Icon name="play" size={20} stroke={2.4} className="translate-x-px" />
            )}
          </button>
          {STANDALONE ? null : owned || dl ? (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center text-accent" title={owned || dl === 'done' ? 'Есть в библиотеке' : 'В загрузках'}>
              <Icon name="check" size={20} stroke={2.6} />
            </span>
          ) : (
            <IconButton icon="download" label="Скачать" onClick={download} busy={busy} />
          )}
          <IconButton icon="x" label="Закрыть плеер" onClick={stopListening} size={18} className="w-9 text-muted" />
        </div>
        {track.rec && (
          <div className="flex items-center gap-1 border-t border-line/60 py-0.5 pl-3 pr-1" role="group" aria-label="Рекомендация">
            <Icon name="sparkle" size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{track.rec.label}</span>
            <IconButton icon="plus" label={track.rec.label.includes('любим') ? 'В понравившиеся' : 'Добавить в плейлист'} onClick={() => void addRec(track)} size={18} className="h-8 w-9 !text-accent" />
            <IconButton icon="minus" label="Не рекомендовать здесь" onClick={() => void hideRec(track)} size={18} className="h-8 w-9 text-muted" />
          </div>
        )}
        <div className="flex items-center gap-2 pb-1 pl-1 pr-1 text-[11px] tabular-nums text-muted">
          <IconButton icon="prev" label={canPrev ? 'Предыдущий трек' : 'Сначала'} onClick={prev} size={16} className="h-8 w-8 text-muted" />
          <span className="w-9 shrink-0 text-right">{fmtDuration(shownPos) || '0:00'}</span>
          <input
            type="range"
            className="qqmusic-range min-w-0 flex-1"
            aria-label="Перемотка"
            min={0}
            max={Math.max(1, Math.round(duration))}
            step={1}
            value={Math.round(shownPos)}
            disabled={!duration || phase === 'resolving' || phase === 'error'}
            style={{ '--p': `${pct}%` } as CSSProperties}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          <span className="w-9 shrink-0">{fmtDuration(duration) || '–:––'}</span>
          <IconButton icon="next" label="Следующий трек" onClick={() => void next()} disabled={!canNext} size={16} className="h-8 w-8 text-muted" />
        </div>
      </div>
    </div>
  );
}

/** Keeps the end of the page above the player (the app's style fixes `main`'s bottom padding). */
export function PlayerSpacer() {
  const shown = useListen((s) => !!s.track);
  return shown ? <div aria-hidden="true" style={{ height: 'var(--player-h, 0px)' }} /> : null;
}
