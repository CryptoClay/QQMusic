import { useEffect, useRef, useState } from 'react';
import { getListenState, moveInQueue, playQueueAt, removeFromQueue, useListen } from '../lib/listen';
import { fmtDuration } from '../lib/format';
import { Cover, IconButton, cx } from './ui';
import { TrackMenuButton } from './TrackMenu';
import { Icon } from './Icon';

const rowIds = new WeakMap<object, number>();
let nextRow = 0;

export function PlayerQueue() {
  const queue = useListen((s) => s.queue);
  const index = useListen((s) => s.index);
  const phase = useListen((s) => s.phase);
  const onWave = useListen((s) => s.context.startsWith('wave:'));
  const current = useRef<HTMLLIElement>(null);
  const box = useRef<HTMLElement>(null);
  const drag = useRef<{ from: number; to: number; y: number; queue: typeof queue; active: boolean } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const occurrences = new Map<number, number>();
  const rowKey = (track: object) => {
    if (!rowIds.has(track)) rowIds.set(track, ++nextRow);
    const id = rowIds.get(track)!;
    const occurrence = occurrences.get(id) || 0;
    occurrences.set(id, occurrence + 1);
    return `${id}:${occurrence}`;
  };
  const cancel = () => {
    drag.current = null;
    setOver(null);
  };
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
      <p id="queue-drag-help" className="px-4 pb-2 text-[11px] text-dim">
        Потяните за точки, чтобы изменить порядок. Стрелки на ручке тоже работают.
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ul className="space-y-1 px-2 pb-3">
        {queue.map((track, i) => (
          <li
            key={rowKey(track)}
            data-queue-index={i}
            ref={i === index ? current : undefined}
            aria-current={i === index ? 'true' : undefined}
            className={cx(
              'group flex items-center gap-1 rounded-xl px-2',
              i === index ? 'bg-white/[.07]' : 'hover:bg-white/[.03]',
              i < index && 'opacity-45',
              over === i && 'ring-1 ring-inset ring-accent',
            )}
          >
            <button
              type="button"
              className="inline-flex h-10 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-dim hover:text-fg active:cursor-grabbing"
              aria-label={`Переместить «${track.title}»`}
              aria-describedby="queue-drag-help"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { from: i, to: i, y: event.clientY, queue, active: false };
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (!current) return;
                if (!current.active && Math.abs(event.clientY - current.y) < 6) return;
                current.active = true;
                const target = document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>('[data-queue-index]');
                if (target && box.current?.contains(target)) {
                  current.to = Number(target.dataset.queueIndex);
                  setOver(current.to);
                }
                const bounds = box.current?.getBoundingClientRect();
                if (bounds && box.current) {
                  if (event.clientY > bounds.bottom - 30) box.current.scrollTop += 12;
                  else if (event.clientY < bounds.top + 30) box.current.scrollTop -= 12;
                }
              }}
              onPointerUp={() => {
                const current = drag.current;
                cancel();
                if (!current?.active) return;
                if (getListenState().queue !== current.queue) {
                  setAnnouncement('Очередь изменилась. Повторите перемещение.');
                  return;
                }
                moveInQueue(current.from, current.to);
                setAnnouncement(`${track.title}: позиция ${current.to + 1}`);
              }}
              onPointerCancel={cancel}
              onLostPointerCapture={cancel}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  cancel();
                  return;
                }
                if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const to = Math.max(0, Math.min(queue.length - 1, i + (event.key === 'ArrowUp' ? -1 : 1)));
                moveInQueue(i, to);
                setAnnouncement(`${track.title}: позиция ${to + 1}`);
              }}
            >
              <Icon name="grip" size={16} />
            </button>
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
            {i !== index && (
              <IconButton
                icon="x"
                label="Убрать из очереди"
                onClick={() => removeFromQueue(i)}
                size={15}
                className="h-8 w-8 !text-muted"
              />
            )}
            <TrackMenuButton
              track={track}
              inPlayer
              extra={[
                ...(i > 0
                  ? [{ icon: 'move' as const, label: 'Поднять в очереди', onClick: () => moveInQueue(i, i - 1) }]
                  : []),
                ...(i < queue.length - 1
                  ? [{ icon: 'move' as const, label: 'Опустить в очереди', onClick: () => moveInQueue(i, i + 1) }]
                  : []),
              ]}
              className="!h-8 !w-8 !text-muted"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
