import { useEffect, useRef, useState } from 'react';
import { request } from '../api/client';
import { Button, ErrorState, Loading, Notice } from '../components/ui';
import { fmtDeadline, fmtDuration } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { getListenState, stopListening } from '../lib/listen';
import { toastError } from '../lib/ui';

interface SharedTrack {
  uid: string;
  title: string;
  artist: string;
  duration_s: number | null;
  available: boolean;
  stream_url: string;
}
interface PublicInfo {
  name: string;
  access: string;
  expires_at: string;
  tracks: SharedTrack[];
}

export function PublicSharePage({ token }: { token: string }) {
  const res = useAsync((s) => request<PublicInfo>('GET', '/api/public/' + token, { signal: s }), [token]);
  const audio = useRef<HTMLAudioElement>(null);
  const [current, setCurrent] = useState<number | null>(null);
  useEffect(() => {
    if (getListenState().track) stopListening();
  }, []);
  useEffect(() => {
    const player = audio.current;
    return () => player?.pause();
  }, [res.data]);
  const play = (index: number) => {
    const track = res.data?.tracks[index];
    if (!track?.available || !audio.current) return;
    audio.current.src = track.stream_url;
    void audio.current.play().catch(toastError);
    setCurrent(index);
  };
  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-6 sm:px-8">
      <header className="mb-8 flex items-center justify-between gap-4">
        <a href="/#/home" className="text-xl font-bold text-accent">
          QQMusic
        </a>
        <a href="/#/home" className="text-sm text-muted">
          Моя библиотека →
        </a>
      </header>
      {res.loading ? (
        <Loading />
      ) : res.error ? (
        <>
          <ErrorState text={res.error} onRetry={() => res.reload()} />
          <p className="mt-4 text-center text-sm text-muted">
            Закрытая ссылка требует входа в аккаунт участника. Отозванную или истёкшую ссылку нужно получить заново.
          </p>
        </>
      ) : (
        res.data && (
          <>
            <h1 className="break-words text-2xl font-bold sm:text-3xl">{res.data.name}</h1>
            <p className="mt-2 text-sm text-muted">
              {res.data.tracks.length} треков · доступ до {fmtDeadline(res.data.expires_at)}
            </p>
            <div className="my-5 space-y-3 rounded-xl border border-line bg-surface p-4">
              <p className="break-words text-sm font-semibold">
                {current === null
                  ? 'Выберите трек'
                  : `${res.data.tracks[current].artist} — ${res.data.tracks[current].title}`}
              </p>
              <audio
                ref={audio}
                controls
                hidden={current === null}
                preload="none"
                className="w-full"
                onEnded={() => {
                  const next = res.data!.tracks.findIndex((t, i) => i > (current ?? -1) && t.available);
                  if (next >= 0) play(next);
                }}
                onError={() =>
                  toastError(new Error('Аудио недоступно. Возможно, ссылка отозвана или срок действия истёк.'))
                }
              />
            </div>
            <Notice kind="info">
              Это снимок выбранной музыки. Ссылка не открывает остальную библиотеку или личные данные владельца.
            </Notice>
            <ul className="mt-5 divide-y divide-line">
              {res.data.tracks.map((t, i) => (
                <li key={`${i}:${t.uid}`} className="flex min-w-0 items-center gap-3 py-4">
                  <span className="w-6 shrink-0 text-sm text-dim">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold">{t.title}</span>
                    <span className="text-sm text-muted">
                      {t.artist} · {fmtDuration(t.duration_s)}
                    </span>
                  </span>
                  <Button small disabled={!t.available} onClick={() => play(i)}>
                    {!t.available ? 'Нет файла' : current === i ? 'Сначала' : 'Слушать'}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </main>
  );
}
