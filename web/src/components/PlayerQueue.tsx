import { useEffect, useRef } from 'react';
import { moveInQueue, playQueueAt, removeFromQueue, useListen } from '../lib/listen';
import { fmtDuration } from '../lib/format';
import { Cover, IconButton, cx } from './ui';
import { TrackMenuButton } from './TrackMenu';

export function PlayerQueue() {
  const queue = useListen((s) => s.queue);
  const index = useListen((s) => s.index);
  const phase = useListen((s) => s.phase);
  const onWave = useListen((s) => s.context.startsWith('wave:'));
  const current = useRef<HTMLLIElement>(null);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = current.current,
      panel = box.current;
    if (row && panel) panel.scrollTop = Math.max(0, row.offsetTop - panel.offsetTop - 64);
  }, []);
  return (
    <section ref={box} aria-label="Очередь" className="player-queue min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-[#202020] px-4 py-4">
        <h2 className="font-semibold">Сейчас и далее</h2>
        <span className="text-xs text-muted">
          {onWave ? 'Моя волна' : `Далее: ${Math.max(0, queue.length - index - 1)}`}
        </span>
      </div>
      <ul className="space-y-1 px-2 pb-3">
        {queue.map((track, i) => (
          <li
            key={`${track.ref}:${i}`}
            ref={i === index ? current : undefined}
            aria-current={i === index ? 'true' : undefined}
            className={cx(
              'group flex items-center gap-1 rounded-xl px-2',
              i === index ? 'bg-white/[.07]' : 'hover:bg-white/[.03]',
              i < index && 'opacity-45',
            )}
          >
            <button
              type="button"
              onClick={() => playQueueAt(i)}
              aria-label={`Слушать «${track.title}»`}
              className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left"
            >
              <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-dim">
                {i === index && phase === 'playing' ? (
                  <span className="player-equalizer" aria-label="Играет">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  i + 1
                )}
              </span>
              <Cover src={track.cover_small_url || track.cover_url} size={40} alt="" />
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-sm font-medium', i === index && 'text-accent')}>
                  {track.title}
                </span>
                <span className="block truncate text-xs text-muted">{track.artist}</span>
              </span>
              <span className="hidden text-xs tabular-nums text-dim min-[400px]:block">
                {fmtDuration(track.duration_s)}
              </span>
            </button>
            {i > index + 1 && (
              <IconButton
                icon="back"
                label="Поднять выше"
                onClick={() => moveInQueue(i, i - 1)}
                size={15}
                className="h-8 w-8 rotate-90 !text-muted"
              />
            )}
            {i !== index && (
              <IconButton
                icon="x"
                label="Убрать из очереди"
                onClick={() => removeFromQueue(i)}
                size={15}
                className="h-8 w-8 !text-muted"
              />
            )}
            <TrackMenuButton track={track} inPlayer className="!h-8 !w-8 !text-muted" />
          </li>
        ))}
      </ul>
    </section>
  );
}
