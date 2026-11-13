import { useMemo, useState } from 'react';
import { api, request } from '../api/client';
import type { DownloadItemOut } from '../api/types';
import { Icon } from '../components/Icon';
import { sourceErrorSummary } from '../components/SourceProblem';
import { Button, Cover, Empty, ErrorState, IconButton, PageHeader, ProgressBar, Segmented, SkeletonRows, StatusChip, cx } from '../components/ui';
import { useDesktop } from '../lib/desktop';
import { useHubConnected, useHubEvent } from '../lib/events';
import { DOWNLOAD_ACTIVE, fmtDeadline, fmtWhen, providerLabel, warningText } from '../lib/format';
import { useAsync, useInterval } from '../lib/hooks';
import { canPlay, playList } from '../lib/player';
import { Link } from '../lib/router';
import { attempt, toast } from '../lib/ui';

interface QueueJob { priority: number; job_status: string; attempts: number; max_attempts: number; retry_at: string | null }
interface QueueControl { paused: boolean; items: Record<string, QueueJob> }

type Filter = 'all' | 'active' | 'problems';

export function DownloadsPage() {
  const res = useAsync((s) => api.downloads(undefined, 200, s), []);
  const control = useAsync(s => request<QueueControl>('GET', '/api/downloads/control', { signal: s }), []);
  const [controlling, setControlling] = useState(false);
  useHubEvent('community', () => control.reload(true));
  const changePause = async () => {
    if (!control.data) return;
    setControlling(true);
    const result = await attempt(() => request<{paused:boolean}>('PUT', '/api/downloads/control', { json:{paused:!control.data!.paused} }));
    setControlling(false);
    if (result) control.setData(previous => previous ? {...previous,paused:result.paused} : previous);
  };
  const connected = useHubConnected();
  const [filter, setFilter] = useState<Filter>('all');
  const [clearing, setClearing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reason, setReason] = useState('all');
  const [retrying, setRetrying] = useState(false);

  // Live updates: upsert the item; unknown items (new batches) are prepended.
  useHubEvent('download', (d) => {
    res.setData((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((x) => x.id === d.id);
      if (i < 0) return [d, ...prev];
      const next = prev.slice();
      next[i] = { ...prev[i], ...d, candidates: prev[i].candidates };
      return next;
    });
  });
  useHubEvent('reconnect', () => res.reload(true));

  // downloads queued only for ♥ or by an import are the Hub's own business: not shown (an import has its card); a ♥
  // download that failed comes with `star` false and is shown
  const imports = useAsync((s) => api.imports(s), []);
  useHubEvent('import', () => imports.reload(true));
  const running = (imports.data ?? []).filter((x) => x.status === 'running');
  useInterval(() => imports.reload(true), running.length ? 15_000 : null);
  const items = useMemo(() => (res.data ?? []).filter((x) => !x.star), [res.data]);
  const counts = useMemo(
    () => ({
      active: items.filter((x) => DOWNLOAD_ACTIVE.includes(x.status)).length,
      problems: items.filter((x) => x.status === 'failed' || x.status === 'needs_review').length,
      finished: items.filter((x) => x.status === 'done' || x.status === 'cancelled').length,
    }),
    [items],
  );
  useInterval(() => control.reload(true), counts.active ? 5000 : null);
  const byReason = (error: string | null | undefined) => { const t=(error??'').toLowerCase(); return /cookies|робот|not a bot|сессия/.test(t)?'session':/403|forbidden/.test(t)?'access':/ssl|tls|timeout|сеть|ожидания/.test(t)?'network':'other'; };
  const shown = items.filter((x) => reason==='all' || byReason(x.error)===reason).filter((x) =>
    filter === 'active' ? DOWNLOAD_ACTIVE.includes(x.status) : filter === 'problems' ? x.status === 'failed' || x.status === 'needs_review' : true,
  );

  const clear = async () => {
    setClearing(true);
    const r = await attempt(() => api.clearDownloads());
    setClearing(false);
    if (r) {
      toast(r.removed ? `Убрано из списка: ${r.removed}` : 'Нечего очищать', 'success');
      res.setData((prev) => prev?.filter((x) => x.status !== 'done' && x.status !== 'cancelled'));
    }
  };

  const act = async (item: DownloadItemOut, kind: 'retry' | 'cancel') => {
    setBusyId(item.id);
    const r = await attempt(() => (kind === 'retry' ? api.retry(item.id) : api.cancel(item.id)));
    setBusyId(null);
    if (r) res.setData((prev) => prev?.map((x) => (x.id === r.id ? { ...x, ...r } : x)));
  };

  const desktop = useDesktop();
  const repeatProblems = async () => {setRetrying(true);const ids=shown.filter((x)=>['failed','needs_review'].includes(x.status)).slice(0,100).map((x)=>x.id); const result=await attempt(()=>request<{queued:number}>('POST','/api/downloads/retry-batch',{json:{ids}})); if(result){toast(`Повторно поставлено в очередь: ${result.queued}`,'success');res.reload();}setRetrying(false);};
  const priority = async (id:number, value:number) => {const result=await attempt(()=>request('POST',`/api/downloads/items/${id}/priority`,{json:{priority:value}}));if(result){control.reload(true);toast('Приоритет сохранён','success');}};

  return (
    <div className={desktop ? 'w-full max-w-[900px] px-8 pb-12' : ''}>
      <PageHeader
        title="Загрузки"
        sub={
          <span className="inline-flex items-center gap-1.5">
            <span className={cx('h-2 w-2 rounded-full', res.error ? 'bg-danger' : connected ? 'bg-accent' : 'bg-dim')} />
            {res.error ? 'нет связи' : connected ? 'онлайн' : 'переподключаюсь…'}
          </span>
        }
        right={
          <Button small variant="ghost" busy={clearing} disabled={!counts.finished} onClick={clear}>
            Очистить готовые
          </Button>
        }
      />
      <div className="mx-4 mb-4 rounded-xl border border-line bg-surface p-4 text-sm">
        {control.error ? <ErrorState text={control.error} onRetry={() => control.reload()} /> : <>
          <div className="flex flex-wrap items-center justify-between gap-3"><strong>{!control.data ? 'Проверяю состояние очереди…' : control.data.paused ? 'Очередь приостановлена' : 'Очередь работает'}</strong><Button small busy={controlling} disabled={!control.data} onClick={() => void changePause()}>{control.data?.paused ? 'Продолжить очередь' : 'Приостановить очередь'}</Button></div>
          <p className="mt-2 text-muted">Пауза действует для вашего аккаунта на всех устройствах и сохраняется после перезапуска. Уже начатые файлы завершатся; новые скачивания не запускаются.</p>
          <p className="mt-1 text-xs text-muted">Автоматически повторяются только временные сетевые ошибки. Вход в источник, недоступный файл и неверные данные требуют вашего действия.</p>
        </>}
      </div>
      {running.map((imp) => (
        <Link key={imp.id} to={`/import/${imp.id}`} className="card mx-4 mb-3 flex items-center gap-3 p-3 hover:bg-hover">
          <Icon name="transfer" size={22} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">Перенос из Яндекс Музыки</span>
            <span className="block truncate text-xs text-muted">
              {imp.stats.pending ? `сопоставляем · осталось ${imp.stats.pending}` : `скачано ${imp.stats.done} · качается ${imp.stats.downloading}`}
            </span>
          </span>
          <Icon name="chevron" size={18} className="text-dim" />
        </Link>
      ))}
      <div className="px-4 pb-2">
        <Segmented<Filter>
          label="Фильтр"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `Все ${items.length || ''}`.trim() },
            { value: 'active', label: `Активные ${counts.active || ''}`.trim() },
            { value: 'problems', label: `Проблемы ${counts.problems || ''}`.trim() },
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-4"><select className="input w-auto max-w-full text-sm" aria-label="Причина ошибки" value={reason} onChange={(e)=>setReason(e.target.value)}><option value="all">Все причины</option><option value="session">Вход и cookies</option><option value="access">Отказ в доступе</option><option value="network">Сеть и таймауты</option><option value="other">Другие ошибки</option></select><Button small busy={retrying} disabled={!shown.some((x)=>['failed','needs_review'].includes(x.status))} onClick={()=>void repeatProblems()}>Повторить проблемы · до 100</Button></div>
      {res.loading ? (
        <SkeletonRows />
      ) : res.error ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : shown.length === 0 ? (
        <Empty icon="download" title={filter === 'all' ? 'Загрузок пока нет' : 'Здесь пусто'} text={filter === 'all' ? 'Найдите трек или альбом в поиске и нажмите «Скачать».' : undefined}>
          {filter === 'all' && (
            <Link to="/search" className="mt-2 rounded-full bg-fg px-5 py-2.5 font-semibold text-bg">
              Перейти к поиску
            </Link>
          )}
        </Empty>
      ) : (
        <ul className="divide-y divide-line/60">
          {shown.map((item) => (
            <DownloadRow
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onRetry={() => act(item, 'retry')}
              onCancel={() => act(item, 'cancel')}
              onPriority={(value) => void priority(item.id,value)}
              job={control.data?.items[String(item.id)]}
              paused={!!control.data?.paused}
              onPlay={canPlay() && item.status === 'done' && item.nd_song_id ? () => playList(shown.filter((x) => x.status === 'done'), (x) => x.nd_song_id, item) : undefined}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DownloadRow({
  item,
  busy,
  onRetry,
  onCancel,
  onPlay,
  onPriority,
  job,
  paused,
}: {
  item: DownloadItemOut;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
  /** Done and scanned by Navidrome: plays it (and the finished ones around it) in the app's player. */
  onPlay?: () => void;
  onPriority: (priority:number) => void;
  job?: QueueJob;
  paused: boolean;
}) {
  const active = DOWNLOAD_ACTIVE.includes(item.status);
  const problem = item.status === 'failed' || item.status === 'needs_review';
  const warnings = (item.warnings ?? []).map(warningText);
  const cover = item.chosen?.cover_url;
  return (
    <li className="flex items-start gap-3 py-3 pl-4 pr-1">
      <Link to={`/downloads/${item.id}`} className="flex min-w-0 flex-1 gap-3" aria-label={`Подробности: ${item.artist} — ${item.title}`}>
        <div className="relative shrink-0">
          <Cover src={cover} size={48} alt="" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px]">{item.title}</div>
          <div className="truncate text-[13px] text-muted">{[item.artist, item.album].filter(Boolean).join(' · ')}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-dim">
            <StatusChip status={item.status} progress={item.progress} />
            {active && job?.job_status === 'queued' && paused && <span className="text-warn">На паузе</span>}
            {active && job?.job_status === 'queued' && job.retry_at && <span>Повтор {job.attempts}/{job.max_attempts} · {fmtDeadline(job.retry_at)}</span>}
            {item.liked && item.status !== 'done' && <span className="text-accent">♥ после загрузки</span>}
            {item.provider && <span>{providerLabel(item.provider)}</span>}
            <span>{fmtWhen(item.updated_at)}</span>
          </div>
          {item.status === 'downloading' && <ProgressBar value={item.progress} className="mt-2" />}
          {warnings.map((w, i) => (
            <div key={i} className="mt-1 flex items-center gap-1 text-xs text-warn">
              <Icon name="alert" size={13} />
              {w}
            </div>
          ))}
          {problem && item.error && <div className="mt-1 line-clamp-2 text-xs text-danger">{sourceErrorSummary(item.error)}</div>}
          {item.status === 'needs_review' && <div className="mt-1 text-xs font-medium text-warn">Нажмите, чтобы выбрать файл вручную</div>}
        </div>
      </Link>
      <div className="flex shrink-0 flex-col items-center">
        {active && job?.job_status === 'queued' && <select aria-label={`Приоритет: ${item.title}`} className="input h-9 w-24 max-w-full text-xs" value={Math.max(0,job.priority)} onChange={e => onPriority(Number(e.target.value))}><option value={0}>Обычный</option><option value={50}>Повышенный</option><option value={100}>Срочно</option></select>}
        {active ? (
          <IconButton icon="x" label="Отменить" busy={busy} onClick={onCancel} className="text-muted" />
        ) : problem || item.status === 'cancelled' ? (
          <IconButton icon="refresh" label="Повторить" busy={busy} onClick={onRetry} className="text-muted" />
        ) : onPlay ? (
          <IconButton icon="play" label={`Слушать «${item.title}»`} onClick={onPlay} className="!text-accent" />
        ) : item.status === 'done' ? (
          <span className="flex h-11 w-11 items-center justify-center text-accent" aria-label="Готово">
            <Icon name="check" size={20} stroke={3} />
          </span>
        ) : null}
      </div>
    </li>
  );
}
