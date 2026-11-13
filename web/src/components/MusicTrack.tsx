import { useEffect, useMemo, useRef, useState } from 'react';
import { request, withQuery } from '../api/client';
import { useAsync } from '../lib/hooks';
import { parseLrc } from '../lib/music';
import { useSession } from '../lib/session';
import { attempt } from '../lib/ui';
import { Button, Field, Loading, Notice } from './ui';

interface Personal {
  note: string;
  tags: string[];
  plain_lyrics: string;
  synced_lyrics: string;
  artist: string;
  title: string;
  lyrics_source: string;
}
interface Lyrics {
  plain_lyrics: string;
  synced_lyrics: string;
  source: string;
}
interface TrackData {
  ref: string;
  personal: Partial<Personal>;
  shared: Partial<Lyrics>;
  lyrics: { plain: string; synced: string; source: string };
  version_ref: string;
  can_confirm_version?: boolean;
  version: { status: string; note?: string; original_ref?: string | null };
}
const empty: Personal = {
  note: '',
  tags: [],
  plain_lyrics: '',
  synced_lyrics: '',
  artist: '',
  title: '',
  lyrics_source: '',
};
const labels: Record<string, string> = {
  unknown: 'Версия не подтверждена',
  original: 'Оригинал · подтверждено',
  edited: 'Изменённая версия · подтверждено',
};
export function MusicTrack({
  refId,
  artist,
  title,
  duration,
  position = 0,
  onSeek,
  playedRef,
  resolvedKey,
  immersive = false,
}: {
  refId: string;
  artist: string;
  title: string;
  duration?: number;
  position?: number;
  onSeek?: (time: number) => void;
  playedRef?: string;
  resolvedKey?: string;
  immersive?: boolean;
}) {
  const { me } = useSession();
  const res = useAsync(
    (signal) =>
      request<TrackData>('GET', withQuery('/api/music/track', { ref: refId, played_ref: playedRef }), {
        signal,
      }),
    [refId, playedRef, resolvedKey],
  );
  const [edit, setEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [own, setOwn] = useState<Personal>(empty),
    [shared, setShared] = useState<Lyrics>({
      plain_lyrics: '',
      synced_lyrics: '',
      source: '',
    });
  const [status, setStatus] = useState('unknown'),
    [versionNote, setVersionNote] = useState(''),
    [original, setOriginal] = useState('');
  const [findMessage, setFindMessage] = useState('');
  const lyricBox = useRef<HTMLDivElement>(null),
    activeLine = useRef<HTMLButtonElement>(null);
  const lines = useMemo(() => parseLrc(res.data?.lyrics.synced ?? ''), [res.data?.lyrics.synced]);
  const active = lines.findLastIndex((line) => line.time <= position);
  useEffect(() => {
    const box = lyricBox.current,
      line = activeLine.current;
    if (box && line) {
      const text = line.getBoundingClientRect(),
        area = box.getBoundingClientRect();
      if (text.top < area.top || text.bottom > area.bottom) box.scrollTop += text.top - area.top - area.height / 2;
    }
  }, [active]);
  const begin = () => {
    const d = res.data;
    if (!d) return;
    setOwn({ ...empty, ...d.personal, artist, title });
    setShared({ plain_lyrics: '', synced_lyrics: '', source: '', ...d.shared });
    setStatus(d.version.status);
    setVersionNote(d.version.note ?? '');
    setOriginal(d.version.original_ref ?? '');
    setEdit(!edit);
  };
  const save = async () => {
    setBusy(true);
    const result = await attempt(
      () =>
        request('PUT', withQuery('/api/music/personal', { ref: refId }), {
          json: {
            ...own,
            tags: own.tags.map((tag) => tag.trim()).filter(Boolean),
          },
        }),
      'Личные данные сохранены',
    );
    if (result) {
      res.reload(true);
      setEdit(false);
    }
    setBusy(false);
  };
  const publish = async () => {
    setBusy(true);
    const result = await attempt(
      () =>
        request('PUT', withQuery('/api/music/lyrics', { ref: refId }), {
          json: shared,
        }),
      'Общий текст опубликован',
    );
    if (result) res.reload(true);
    setBusy(false);
  };
  const confirmVersion = async () => {
    setBusy(true);
    const result = await attempt(
      () =>
        request('PUT', '/api/music/version', {
          json: {
            ref: res.data?.version_ref,
            status,
            note: versionNote,
            original_ref: original || null,
          },
        }),
      'Версия сохранена для всех',
    );
    if (result) res.reload(true);
    setBusy(false);
  };
  const find = async () => {
    setBusy(true);
    setFindMessage('');
    const found = await attempt(() =>
      request<{
        found: boolean;
        instrumental?: boolean;
        plain_lyrics?: string;
        synced_lyrics?: string;
        source?: string;
      }>(
        'GET',
        withQuery('/api/music/lyrics/find', {
          artist,
          title,
          duration: duration ? Math.min(3600, Math.round(duration)) : undefined,
        }),
      ),
    );
    if (found?.found) {
      setOwn((value) => ({
        ...value,
        plain_lyrics: found.plain_lyrics ?? '',
        synced_lyrics: found.synced_lyrics ?? '',
        lyrics_source: found.source ?? '',
      }));
      setShared({
        plain_lyrics: found.plain_lyrics ?? '',
        synced_lyrics: found.synced_lyrics ?? '',
        source: found.source ?? '',
      });
      setFindMessage(
        found.instrumental
          ? 'Источник пометил запись как инструментальную.'
          : 'Текст найден. Проверьте его и сохраните.',
      );
    } else if (found) setFindMessage('Текст не найден. Можно добавить его вручную.');
    setBusy(false);
  };
  return (
    <section className={immersive ? 'space-y-5 p-5' : 'space-y-4 rounded-2xl border border-line bg-surface p-4'} aria-label="Текст, версия и заметки">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{immersive ? 'Текст песни' : 'Текст и версия трека'}</h2>
        <Button small disabled={!res.data || res.loading} onClick={begin}>
          {edit ? 'Закрыть редактор' : 'Текст и заметки'}
        </Button>
      </div>
      {res.loading && !res.data ? (
        <Loading />
      ) : res.error ? (
        <Notice kind="error">{res.error}</Notice>
      ) : (
        res.data && (
          <>
            <p className={res.data.version.status === 'edited' ? 'text-sm text-warn' : 'text-sm text-muted'}>
              {labels[res.data.version.status] ?? labels.unknown}
            </p>
            {res.data.version.note && <p className="text-sm text-muted">{res.data.version.note}</p>}
            <div ref={lyricBox} className={immersive ? 'max-h-[55dvh] space-y-5 overflow-y-auto' : 'max-h-80 space-y-3 overflow-y-auto'} aria-label="Текст песни">
              {lines.length ? (
                lines.map((line, i) => (
                  <button
                    ref={i === active ? activeLine : undefined}
                    type="button"
                    key={`${line.time}:${i}`}
                    disabled={!onSeek}
                    onClick={() => onSeek?.(line.time)}
                    aria-current={i === active ? 'true' : undefined}
                    className={`block w-full text-left ${immersive ? 'text-xl font-semibold leading-relaxed' : 'leading-7'} ${i === active ? 'font-semibold text-accent' : 'text-muted'}`}
                  >
                    {line.text || '♪'}
                  </button>
                ))
              ) : (
                <p className={immersive ? 'whitespace-pre-wrap text-xl font-semibold leading-relaxed text-white/75' : 'whitespace-pre-wrap leading-7 text-muted'}>
                  {res.data.lyrics.plain || 'Текст пока не добавлен.'}
                </p>
              )}
            </div>
            {res.data.lyrics.source &&
              (res.data.lyrics.source.startsWith('https://') ? (
                <a
                  className="text-xs text-muted underline"
                  href={res.data.lyrics.source}
                  target="_blank"
                  rel="noreferrer"
                >
                  Источник текста
                </a>
              ) : (
                <p className="text-xs text-muted">{res.data.lyrics.source}</p>
              ))}
            {(res.data.personal.note || res.data.personal.tags?.length) && (
              <div className="rounded-xl bg-raised p-3">
                <p className="text-xs text-muted">Только для вас · {res.data.personal.tags?.join(' · ')}</p>
                <p className="whitespace-pre-wrap text-sm">{res.data.personal.note}</p>
              </div>
            )}
            {edit && (
              <div className="space-y-4 border-t border-line pt-4">
                <p className="text-sm text-muted">
                  Личный текст, метки и заметки видны только вашему аккаунту. Синхронизация: строки вида
                  [00:12.50]Текст.
                </p>
                <Field label="Мои метки через запятую">
                  <input
                    className="input"
                    maxLength={800}
                    value={own.tags.join(', ')}
                    onChange={(e) =>
                      setOwn({
                        ...own,
                        tags: e.target.value
                          .split(',')
                          .map((tag) => tag.trimStart())
                          .slice(0, 20),
                      })
                    }
                  />
                </Field>
                <Field label="Моя заметка">
                  <textarea
                    className="input min-h-20"
                    maxLength={4000}
                    value={own.note}
                    onChange={(e) => setOwn({ ...own, note: e.target.value })}
                  />
                </Field>
                <Button small busy={busy} disabled={!artist || !title} onClick={() => void find()}>
                  Найти текст в LRCLIB
                </Button>
                <p className="text-xs text-muted">
                  В LRCLIB будут отправлены исполнитель, название и длительность. Результат можно проверить перед
                  сохранением.
                </p>
                {findMessage && <Notice>{findMessage}</Notice>}
                <Field label="Мой текст песни">
                  <textarea
                    className="input min-h-32"
                    maxLength={40000}
                    value={own.plain_lyrics}
                    onChange={(e) => setOwn({ ...own, plain_lyrics: e.target.value })}
                  />
                </Field>
                <Field label="Мой синхронизированный текст (LRC)">
                  <textarea
                    className="input min-h-32"
                    maxLength={40000}
                    value={own.synced_lyrics}
                    onChange={(e) => setOwn({ ...own, synced_lyrics: e.target.value })}
                  />
                </Field>
                <Button variant="primary" busy={busy} onClick={() => void save()}>
                  Сохранить только для меня
                </Button>
                {me.is_admin && (
                  <details className="space-y-4 rounded-xl border border-line p-3">
                    <summary className="cursor-pointer font-semibold">Общие данные · администратор</summary>
                    <p className="text-sm text-muted">
                      Подтверждение относится к конкретному файлу. Отметка Explicit сама по себе не подтверждает
                      отсутствие цензуры.
                    </p>
                    <Field label="Версия">
                      <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="unknown">Не подтверждена</option>
                        <option value="original">Оригинал</option>
                        <option value="edited">Изменённая</option>
                      </select>
                    </Field>
                    <Field label="Основание подтверждения">
                      <textarea
                        className="input"
                        maxLength={2000}
                        value={versionNote}
                        onChange={(e) => setVersionNote(e.target.value)}
                      />
                    </Field>
                    <Field label="Ссылка ref на оригинал">
                      <input
                        className="input"
                        value={original}
                        onChange={(e) => setOriginal(e.target.value)}
                        placeholder="file:yt_reupload:… или nd:…"
                      />
                    </Field>
                    <p className="break-all text-xs text-muted">Текущий файл: {res.data.version_ref}</p>
                    {!res.data.can_confirm_version && (
                      <p className="text-sm text-muted">
                        Для подтверждения выберите конкретный файл в поиске или трек в библиотеке.
                      </p>
                    )}
                    <Button busy={busy} disabled={!res.data.can_confirm_version} onClick={() => void confirmVersion()}>
                      Сохранить подтверждение
                    </Button>
                    <Field label="Общий текст">
                      <textarea
                        className="input min-h-32"
                        maxLength={40000}
                        value={shared.plain_lyrics}
                        onChange={(e) => setShared({ ...shared, plain_lyrics: e.target.value })}
                      />
                    </Field>
                    <Field label="Общий LRC">
                      <textarea
                        className="input min-h-32"
                        maxLength={40000}
                        value={shared.synced_lyrics}
                        onChange={(e) =>
                          setShared({
                            ...shared,
                            synced_lyrics: e.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="Источник общего текста (HTTPS)">
                      <input
                        className="input"
                        value={shared.source}
                        onChange={(e) => setShared({ ...shared, source: e.target.value })}
                      />
                    </Field>
                    <Button busy={busy} onClick={() => void publish()}>
                      Опубликовать текст для всех
                    </Button>
                  </details>
                )}
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
