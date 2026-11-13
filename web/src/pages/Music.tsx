import { useState } from 'react';
import { request, withQuery } from '../api/client';
import { MusicTrack } from '../components/MusicTrack';
import { Button, Empty, ErrorState, Field, Loading, Notice, PageHeader } from '../components/ui';
import { EQ_FREQUENCIES } from '../lib/audioEffects';
import { useAsync, useDebounced } from '../lib/hooks';
import { listenAll } from '../lib/listen';
import { DEFAULT_MUSIC, saveMusic, useMusicSettings, type MusicPreferences } from '../lib/music';
import { Link, enc } from '../lib/router';
import { attempt } from '../lib/ui';
import { canPlayAll } from '../lib/player';

export function MusicSettingsPage() {
  const saved = useMusicSettings();
  const [draft, setDraft] = useState<MusicPreferences | null>(null),
    [busy, setBusy] = useState(false);
  const value = draft ?? saved;
  const patch = (data: Partial<MusicPreferences>) => setDraft({ ...value, ...data });
  const apply = async () => {
    setBusy(true);
    const result = await attempt(async () => {
      await saveMusic(value);
      return true;
    }, 'Настройки музыки сохранены');
    if (result) setDraft(null);
    setBusy(false);
  };
  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader title="Музыка и звук" back="/more" />
      <div className="space-y-5 px-4">
        <section className="space-y-4 rounded-2xl border border-line bg-surface p-5">
          <h2 className="text-lg font-semibold">Предпочтения аккаунта</h2>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={value.prefer_original}
              onChange={(e) => patch({ prefer_original: e.target.checked })}
            />
            Предпочитать подтверждённые оригиналы
          </label>
          <p className="text-sm text-muted">
            Подтверждения относятся к конкретным файлам. Если версия изменена и оригинал не указан, плеер сообщит об
            этом. Непроверенные версии не считаются оригиналами автоматически.
          </p>
          <Field label="Знакомая музыка в радио">
            <select
              className="input"
              value={value.radio_mode}
              onChange={(e) =>
                patch({
                  radio_mode: e.target.value as MusicPreferences['radio_mode'],
                })
              }
            >
              <option value="favorites">Больше знакомого</option>
              <option value="normal">Баланс знакомого и нового</option>
              <option value="discover">Больше открытий</option>
            </select>
          </Field>
          <p className="text-xs text-muted">
            Это предпочтение для новых запусков радио. Состав зависит от доступных рекомендаций.
          </p>
        </section>
        <section className="space-y-4 rounded-2xl border border-line bg-surface p-5">
          <h2 className="text-lg font-semibold">Звук веб-плеера</h2>
          {canPlayAll() && (
            <Notice>
              В приложении Android эти эффекты действуют только в веб-плеере. Нативный плеер использует свои настройки
              звука.
            </Notice>
          )}
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={value.eq_enabled}
              onChange={(e) => patch({ eq_enabled: e.target.checked })}
            />
            Эквалайзер
          </label>
          <div className="space-y-3">
            {EQ_FREQUENCIES.map((frequency, i) => (
              <label key={frequency} className="flex items-center gap-3 text-sm">
                <span className="w-16 shrink-0">
                  {frequency < 1000 ? `${frequency} Гц` : `${frequency / 1000} кГц`}
                </span>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  className="hm-range min-w-0 flex-1"
                  disabled={!value.eq_enabled}
                  value={value.eq_gains[i]}
                  onChange={(e) =>
                    patch({
                      eq_gains: value.eq_gains.map((gain, j) => (j === i ? Number(e.target.value) : gain)),
                    })
                  }
                />
                <span className="w-12 text-right tabular-nums">{value.eq_gains[i]} dB</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button small onClick={() => patch({ eq_gains: [0, 0, 0, 0, 0, 0] })}>
              Ровно
            </Button>
            <Button small onClick={() => patch({ eq_enabled: true, eq_gains: [5, 3, 0, -1, 1, 2] })}>
              Бас
            </Button>
            <Button small onClick={() => patch({ eq_enabled: true, eq_gains: [-2, -1, 1, 3, 2, 0] })}>
              Вокал
            </Button>
          </div>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={value.normalization}
              onChange={(e) => patch({ normalization: e.target.checked })}
            />
            Выравнивать громкость
          </label>
          <p className="text-xs text-muted">
            Плавная автоматическая подстройка по текущему звуку и ограничение пиков; тихие фрагменты могут звучать
            громче.
          </p>
          <Field label={`Плавный переход: ${value.crossfade_s} сек.`}>
            <input
              className="hm-range w-full"
              type="range"
              min={0}
              max={10}
              step={1}
              value={value.crossfade_s}
              onChange={(e) => patch({ crossfade_s: Number(e.target.value) })}
            />
          </Field>
          <p className="text-xs text-muted">
            Переходы между следующими треками очереди. На коротких треках длительность сокращается; при буферизации
            переход может быть короче.
          </p>
        </section>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" busy={busy} onClick={() => void apply()}>
            Сохранить и применить
          </Button>
          <Button disabled={busy} onClick={() => setDraft({ ...DEFAULT_MUSIC, eq_gains: [0, 0, 0, 0, 0, 0] })}>
            Сбросить
          </Button>
        </div>
        <p className="text-xs text-muted">
          Настройки хранятся отдельно для вашего аккаунта. Звук изменится после сохранения.
        </p>
      </div>
    </div>
  );
}

export function TrackDetailsPage({ refId, title, artist }: { refId: string; title: string; artist: string }) {
  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader title={title || 'О треке'} sub={artist} back="/library" />
      <div className="px-4">
        <MusicTrack key={refId} refId={refId} artist={artist} title={title} />
      </div>
    </div>
  );
}

interface Note {
  ref: string;
  artist: string;
  title: string;
  note: string;
  tags: string[];
}
export function NotesPage() {
  const [q, setQ] = useState(''),
    [tag, setTag] = useState('');
  const search = useDebounced(q, 250),
    selectedTag = useDebounced(tag, 250);
  const res = useAsync(
    (signal) =>
      request<Note[]>('GET', withQuery('/api/music/notes', { q: search, tag: selectedTag }), {
        signal,
      }),
    [search, selectedTag],
  );
  const data = res.data ?? [];
  const play = () =>
    listenAll(
      data.map((item) => ({
        ref: item.ref,
        title: item.title || 'Без названия',
        artist: item.artist,
      })),
      { context: 'notes' },
    );
  return (
    <div className="mx-auto max-w-4xl pb-10">
      <PageHeader title="Мои заметки и метки" back="/more" />
      <div className="space-y-4 px-4">
        <p className="text-sm text-muted">Видны только вашему аккаунту. Добавляются из меню трека или плеера.</p>
        <input
          className="input"
          aria-label="Поиск в заметках"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Исполнитель, заметка или метка"
        />
        <input
          className="input"
          aria-label="Фильтр по метке"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="Точная метка, например: дорога"
        />
        {data.length > 0 && (
          <Button icon="play" disabled={canPlayAll()} onClick={play}>
            Слушать подборку в веб-плеере · {data.length}
          </Button>
        )}
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : !data.length ? (
          <Empty title="Пока ничего не найдено" text="Сохраните заметку или метку у любого трека." />
        ) : (
          data.map((item) => (
            <Link
              key={item.ref}
              to={`/track/${enc(item.ref)}?title=${enc(item.title)}&artist=${enc(item.artist)}`}
              className="block space-y-2 rounded-xl border border-line bg-surface p-4"
            >
              <strong>
                {item.artist} — {item.title || item.ref}
              </strong>
              <p className="text-sm text-accent">{item.tags.join(' · ')}</p>
              <p className="whitespace-pre-wrap text-sm text-muted">{item.note}</p>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

interface RecapTrack {
  key: string;
  ref: string | null;
  nd_song_id: string | null;
  artist: string;
  title: string;
  heard?: number;
}
interface Recap {
  totals: {
    counted_listens: number;
    listened_ms: number;
    new_tracks: number;
    unique_artists: number;
  };
  top_tracks: RecapTrack[];
  top_artists: { artist: string; heard: number }[];
  discoveries: RecapTrack[];
  forgotten: RecapTrack[];
}
export function RecapPage() {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const res = useAsync(
    (signal) =>
      request<Recap>(
        'GET',
        withQuery('/api/music/recap', {
          month,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        { signal },
      ),
    [month],
    /^\d{4}-\d{2}$/.test(month),
  );
  const play = (items: RecapTrack[]) =>
    listenAll(
      items.map((t) => ({
        ref: t.nd_song_id ? `nd:${t.nd_song_id}` : (t.ref ?? t.key),
        title: t.title,
        artist: t.artist,
      })),
      { context: 'recap' },
    );
  const list = (title: string, items: RecapTrack[]) => (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {items.length > 0 && (
          <Button small icon="play" disabled={canPlayAll()} onClick={() => play(items)}>
            Слушать
          </Button>
        )}
      </div>
      {items.length ? (
        items.slice(0, 12).map((item) => (
          <p key={item.key} className="text-sm">
            <span className="text-muted">{item.artist} — </span>
            {item.title}
            {item.heard !== undefined && <span className="ml-2 text-xs text-accent">{item.heard} раз</span>}
          </p>
        ))
      ) : (
        <p className="text-sm text-muted">Пока нет данных.</p>
      )}
    </section>
  );
  return (
    <div className="mx-auto max-w-4xl pb-10">
      <PageHeader title="Мои музыкальные итоги" back="/more" />
      <div className="space-y-5 px-4">
        <Field label="Месяц">
          <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <p className="text-sm text-muted">
          Только ваши прослушивания. Время учитывается по фактическим событиям плеера; отсутствие старых измерений не
          заменяется длительностью песен.
        </p>
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState text={res.error} onRetry={() => res.reload()} />
        ) : (
          res.data && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {[
                  [res.data.totals.counted_listens, 'Прослушивания'],
                  [Math.round(res.data.totals.listened_ms / 60000), 'Минуты музыки'],
                  [res.data.totals.new_tracks, 'Новые треки'],
                  [res.data.totals.unique_artists, 'Исполнители'],
                ].map(([value, label]) => (
                  <div key={label} className="rounded-xl bg-surface p-4">
                    <strong className="text-2xl">{value}</strong>
                    <p className="text-sm text-muted">{label}</p>
                  </div>
                ))}
              </div>
              <section className="rounded-xl border border-line bg-surface p-4">
                <h2 className="mb-3 font-semibold">Любимые исполнители месяца</h2>
                {res.data.top_artists.length ? (
                  res.data.top_artists.slice(0, 10).map((item) => (
                    <p key={item.artist} className="py-1 text-sm">
                      {item.artist}
                      <span className="ml-2 text-muted">{item.heard} раз</span>
                    </p>
                  ))
                ) : (
                  <p className="text-sm text-muted">Пока нет прослушиваний.</p>
                )}
              </section>
              {list('Чаще всего слушали', res.data.top_tracks)}
              {list('Открытия месяца', res.data.discoveries)}
              {list('Давно не включали', res.data.forgotten)}
            </>
          )
        )}
      </div>
    </div>
  );
}
