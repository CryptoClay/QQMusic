import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  cycleRepeat,
  cycleShuffle,
  hasNext,
  hasPrev,
  next,
  prev,
  seek,
  setVolume,
  toggle,
  useListen,
} from '../lib/listen';
import { fmtDuration } from '../lib/format';
import { Icon } from './Icon';
import { IconButton, Spinner, cx } from './ui';

export function PlayButton({ large = false }: { large?: boolean }) {
  const phase = useListen((s) => s.phase);
  const waiting = phase === 'resolving' || phase === 'loading';
  const playing = phase === 'playing' || waiting;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={phase === 'error' ? 'Повторить' : playing ? 'Пауза' : 'Слушать'}
      title={phase === 'error' ? 'Повторить' : playing ? 'Пауза' : 'Слушать'}
      className={cx(
        'player-play inline-flex shrink-0 items-center justify-center rounded-full bg-fg text-bg transition hover:scale-105 active:scale-95',
        large ? 'h-16 w-16' : 'h-10 w-10',
      )}
    >
      {waiting ? (
        <Spinner size={large ? 28 : 20} />
      ) : (
        <Icon
          name={phase === 'error' ? 'refresh' : playing ? 'pause' : 'play'}
          size={large ? 28 : 20}
          stroke={playing ? 3 : 2.4}
          className={!playing && phase !== 'error' ? 'translate-x-px' : ''}
        />
      )}
    </button>
  );
}

export function Transport({ large = false }: { large?: boolean }) {
  const shuffle = useListen((s) => s.shuffle);
  const smart = useListen((s) => s.smart);
  const repeat = useListen((s) => s.repeat);
  const onWave = useListen((s) => s.context.startsWith('wave:'));
  const canNext = useListen((s) => hasNext(s) || (s.repeat === 'all' && !s.context.startsWith('wave:')));
  const canPrev = useListen(hasPrev);
  return (
    <div
      className={cx('flex items-center justify-center', large ? 'gap-1 min-[390px]:gap-4 sm:gap-6' : 'gap-3')}
      role="group"
      aria-label="Управление воспроизведением"
    >
      <IconButton
        icon={smart ? 'shuffleSmart' : 'shuffle'}
        label={shuffle ? 'Перемешивание включено' : 'Перемешать'}
        aria-pressed={shuffle}
        disabled={onWave}
        onClick={cycleShuffle}
        size={large ? 22 : 17}
        className={cx(large ? 'h-11 w-11' : 'h-8 w-8', shuffle && !onWave ? '!text-accent' : '!text-muted')}
      />
      <IconButton
        icon="prev"
        label={canPrev ? 'Предыдущий трек' : 'Сначала'}
        onClick={prev}
        size={large ? 29 : 21}
        className={large ? 'h-11 w-11' : 'h-9 w-9'}
      />
      <PlayButton large={large} />
      <IconButton
        icon="next"
        label="Следующий трек"
        onClick={() => void next()}
        disabled={!canNext}
        size={large ? 29 : 21}
        className={large ? 'h-11 w-11' : 'h-9 w-9'}
      />
      <IconButton
        icon={repeat === 'one' ? 'repeat1' : 'repeat'}
        label={repeat === 'off' ? 'Повтор выключен' : repeat === 'all' ? 'Повтор очереди' : 'Повтор трека'}
        aria-pressed={repeat !== 'off'}
        disabled={onWave && repeat !== 'one'}
        onClick={cycleRepeat}
        size={large ? 22 : 17}
        className={cx(large ? 'h-11 w-11' : 'h-8 w-8', repeat !== 'off' ? '!text-accent' : '!text-muted')}
      />
    </div>
  );
}

export function SeekBar({ compact = false }: { compact?: boolean }) {
  const position = useListen((s) => s.position);
  const duration = useListen((s) => s.duration);
  const phase = useListen((s) => s.phase);
  const trackRef = useListen((s) => s.track?.ref);
  const [scrub, setScrub] = useState<number | null>(null);
  const pending = useRef<{ ref: string | undefined; value: number } | null>(null);
  useEffect(() => {
    pending.current = null;
    setScrub(null);
  }, [trackRef]);
  const value = Math.min(duration || position, scrub ?? position);
  const commit = () => {
    if (pending.current?.ref === trackRef && pending.current) seek(pending.current.value);
    pending.current = null;
    setScrub(null);
  };
  const input = (
    <input
      type="range"
      min={0}
      max={Math.max(1, duration)}
      step={0.1}
      value={value}
      aria-label="Перемотка"
      aria-valuetext={`${fmtDuration(value) || '0:00'} из ${fmtDuration(duration) || '0:00'}`}
      disabled={!duration || phase === 'resolving' || phase === 'error'}
      className="qqmusic-range player-seek min-w-0 w-full"
      style={{ '--p': `${duration ? Math.min(100, (value / duration) * 100) : 0}%` } as CSSProperties}
      onChange={(e) => {
        const next = Number(e.target.value);
        pending.current = { ref: trackRef, value: next };
        setScrub(next);
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      onPointerCancel={() => {
        pending.current = null;
        setScrub(null);
      }}
    />
  );
  return compact ? (
    <div className="flex items-center gap-2 text-[11px] tabular-nums text-muted">
      <span className="w-9 shrink-0 text-right">{fmtDuration(value) || '0:00'}</span>
      {input}
      <span className="w-9 shrink-0">{fmtDuration(duration) || '–:––'}</span>
    </div>
  ) : (
    <div>
      {input}
      <div className="mt-0.5 flex justify-between text-xs tabular-nums text-muted">
        <span>{fmtDuration(value) || '0:00'}</span>
        <span>{fmtDuration(duration) || '–:––'}</span>
      </div>
    </div>
  );
}

let audibleVolume = 0.7;
export function VolumeControl({ slider = true }: { slider?: boolean }) {
  const volume = useListen((s) => s.volume);
  useEffect(() => {
    if (volume > 0) audibleVolume = volume;
  }, [volume]);
  return (
    <div className="flex min-w-0 items-center gap-1" role="group" aria-label="Громкость">
      <IconButton
        icon={volume === 0 ? 'mute' : 'volume'}
        label={volume === 0 ? 'Включить звук' : 'Выключить звук'}
        aria-pressed={volume === 0}
        onClick={() => setVolume(volume === 0 ? audibleVolume : 0)}
        size={18}
        className="h-9 w-9 !text-muted"
      />
      {slider && (
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          aria-label="Громкость"
          aria-valuetext={`${Math.round(volume * 100)}%`}
          className="qqmusic-range min-w-0 w-full"
          style={{ '--p': `${volume * 100}%` } as CSSProperties}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
        />
      )}
    </div>
  );
}
