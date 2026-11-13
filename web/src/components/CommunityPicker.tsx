import { useState } from 'react';
import { request } from '../api/client';
import { community, type Collection, type Song } from '../lib/community';
import { useAsync } from '../lib/hooks';
import { Link } from '../lib/router';
import { attempt } from '../lib/ui';
import { Button, Empty, ErrorState, Loading, Sheet } from './ui';

export function CommunityPicker({ song, onClose }: { song: Song; onClose: () => void }) {
  const res = useAsync((s) => community<Collection[]>('/playlists', s), []);
  const [busy, setBusy] = useState(false);
  const choices = res.data?.filter((p) => p.role !== 'listener' && !p.archived) ?? [];
  return (
    <Sheet
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="В совместный плейлист"
    >
      {res.loading ? (
        <Loading />
      ) : res.error ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : !choices.length ? (
        <Empty icon="playlist" title="Нет доступных для редактирования плейлистов">
          <Link className="text-accent" to="/community-playlists" onClick={onClose}>
            Создать совместный плейлист →
          </Link>
        </Empty>
      ) : (
        <ul className="space-y-2">
          {choices.map((p) => (
            <li key={p.id}>
              <Button
                block
                disabled={busy || p.items.length >= 500}
                onClick={async () => {
                  setBusy(true);
                  const result = await attempt(
                    () =>
                      request('PATCH', `/api/community/playlists/${p.id}`, {
                        json: { revision: p.revision, items: [...p.items, song] },
                      }),
                    `Добавлено в «${p.name}»`,
                  );
                  setBusy(false);
                  if (result) onClose();
                  else res.reload();
                }}
              >
                {p.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
