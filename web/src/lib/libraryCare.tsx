import { useEffect, useRef, useState } from 'react';
import { request } from '../api/client';
import { Button, Notice, Sheet } from '../components/ui';
import { toastError } from './ui';

export type LibraryEdit = { action: 'track' | 'album' | 'merge' | 'move'; id: number; ids?: number[]; fields?: object };
export interface LibraryPreview {
  token: string;
  action: LibraryEdit['action'];
  track_count: number;
  target_album?: { id: number; title: string; artist: string } | null;
  can_apply: boolean;
  warnings: string[];
  changes: { field: string; before: unknown; after: unknown }[];
  tracks: { id: number; title: string; artist: string; path: string }[];
}
export interface LibraryApplied {
  ok: boolean;
  album_id: number | null;
}
const labels: Record<string, string> = {
  title: 'Название',
  artist: 'Исполнитель',
  album_artist: 'Исполнитель альбома',
  album: 'Альбом',
  year: 'Год',
  genre: 'Жанр',
  release_type: 'Тип',
  track_no: '№ трека',
  disc_no: 'Диск',
  explicit: '18+',
};
const value = (v: unknown) =>
  v == null || v === '' ? 'Не задано' : typeof v === 'boolean' ? (v ? 'Да' : 'Нет') : String(v);

/** Resolves only after an explicit apply/cancel. The server rejects stale previews. */
export function useLibraryReview() {
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const resolve = useRef<((result: LibraryApplied | null) => void) | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      resolve.current?.(null);
    };
  }, []);
  const close = (result: LibraryApplied | null = null) => {
    resolve.current?.(result);
    resolve.current = null;
    setPreview(null);
  };
  const review = async (operation: LibraryEdit): Promise<LibraryApplied | null> => {
    const p = await request<LibraryPreview>('POST', '/api/library/preview', { json: operation });
    if (!alive.current) return null;
    resolve.current?.(null);
    setPreview(p);
    return new Promise((done) => {
      resolve.current = done;
    });
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      close(await request<LibraryApplied>('POST', '/api/library/apply', { json: { token: preview.token } }));
    } catch (error) {
      toastError(error);
      close();
    } finally {
      setBusy(false);
    }
  };
  const sheet = (
    <Sheet
      open={!!preview}
      onClose={() => {
        if (!busy) close();
      }}
      title="Предпросмотр изменений"
      footer={
        <div className="flex gap-2">
          <Button block disabled={busy} onClick={() => close()}>
            Отмена
          </Button>
          <Button block variant="primary" busy={busy} disabled={!preview?.can_apply} onClick={apply}>
            Применить изменения
          </Button>
        </div>
      }
    >
      {preview && (
        <div className="space-y-4">
          {preview.warnings.map((warning) => (
            <Notice key={warning} kind="info">
              {warning}
            </Notice>
          ))}
          {preview.target_album && (
            <p className="break-words text-sm">
              <strong>{preview.action === 'merge' ? 'Основной альбом' : 'Альбом'}:</strong>{' '}
              {preview.target_album.artist} — {preview.target_album.title} · №{preview.target_album.id}
            </p>
          )}
          <p className="text-sm font-semibold">Затронуто треков: {preview.track_count}</p>
          <dl className="divide-y divide-line rounded-xl border border-line px-3">
            {preview.changes.map((change, index) => (
              <div key={index} className="py-3 text-sm">
                <dt className="font-semibold">{labels[change.field] ?? change.field}</dt>
                <dd className="mt-1 break-words text-muted">
                  {value(change.before)} → <span className="text-fg">{value(change.after)}</span>
                </dd>
              </div>
            ))}
          </dl>
          <details className="text-sm">
            <summary className="cursor-pointer py-2">Файлы и треки</summary>
            <ul className="space-y-3">
              {preview.tracks.map((t) => (
                <li key={t.id}>
                  <p>
                    {t.artist} — {t.title}
                  </p>
                  <p className="break-all text-xs text-dim">{t.path}</p>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </Sheet>
  );
  return { review, sheet };
}
