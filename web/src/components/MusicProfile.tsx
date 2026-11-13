import { useEffect, useState } from 'react';
import { request, withQuery } from '../api/client';
import { useAsync } from '../lib/hooks';
import { useSession } from '../lib/session';
import { attempt } from '../lib/ui';
import { Link, enc } from '../lib/router';
import { Button, Field, Notice } from './ui';

interface Profile {
  biography: string;
  members: string[];
  related: string[];
  source: string;
  cover_url: string;
}
const empty: Profile = {
  biography: '',
  members: [],
  related: [],
  source: '',
  cover_url: '',
};
export function MusicProfile({
  kind,
  refId,
  onCover,
}: {
  kind: 'artist' | 'album';
  refId: string;
  onCover?: (cover: string) => void;
}) {
  const { me } = useSession();
  const url = withQuery(`/api/music/profile/${kind}`, { ref: refId });
  const res = useAsync((signal) => request<Partial<Profile>>('GET', url, { signal }), [kind, refId]);
  const [draft, setDraft] = useState<Profile | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    onCover?.(res.data?.cover_url ?? '');
  }, [res.data?.cover_url, onCover]);
  const profile = { ...empty, ...res.data };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const result = await attempt(
      () =>
        request('PUT', url, {
          json: {
            ...draft,
            members: draft.members.map((s) => s.trim()).filter(Boolean),
            related: draft.related.map((s) => s.trim()).filter(Boolean),
          },
        }),
      'Карточка обновлена для всех',
    );
    if (result) {
      setDraft(null);
      res.reload(true);
    }
    setBusy(false);
  };
  const upload = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    const data = await attempt(() => request<{ cover_url: string }>('POST', '/api/music/cover', { form }));
    if (data) setDraft({ ...(draft ?? profile), cover_url: data.cover_url });
    setBusy(false);
  };
  if (!me.is_admin && !profile.biography && !profile.members.length && !profile.related.length && !res.error)
    return null;
  return (
    <section className="mx-4 my-5 space-y-4 rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{kind === 'artist' ? 'Об исполнителе' : 'Об альбоме'}</h2>
        {me.is_admin && (
          <Button small onClick={() => setDraft(draft ? null : profile)}>
            {draft ? 'Закрыть' : 'Оформить карточку'}
          </Button>
        )}
      </div>
      {res.error && <Notice kind="error">{res.error}</Notice>}
      {profile.biography && <p className="whitespace-pre-wrap text-sm leading-7 text-muted">{profile.biography}</p>}
      {profile.members.length > 0 && (
        <p className="text-sm">
          <span className="text-muted">{kind === 'artist' ? 'Участники' : 'Участники записи'}: </span>
          {profile.members.join(', ')}
        </p>
      )}
      {profile.related.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {profile.related.map((name) => (
            <Link
              key={name}
              className="rounded-full border border-line px-3 py-2 text-sm"
              to={`/search?q=${enc(name)}`}
            >
              {name}
            </Link>
          ))}
        </div>
      )}
      {profile.source && (
        <a href={profile.source} target="_blank" rel="noreferrer" className="text-xs text-muted underline">
          Источник описания
        </a>
      )}
      {!profile.biography && me.is_admin && !draft && (
        <p className="text-sm text-muted">Добавьте описание, участников и связанные проекты для всех слушателей.</p>
      )}
      {draft && (
        <div className="space-y-4 border-t border-line pt-4">
          <Field label="Описание">
            <textarea
              className="input min-h-40"
              maxLength={12000}
              value={draft.biography}
              onChange={(e) => setDraft({ ...draft, biography: e.target.value })}
            />
          </Field>
          <Field label="Участники, по одному в строке">
            <textarea
              className="input"
              value={draft.members.join('\n')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  members: e.target.value.split('\n').slice(0, 100),
                })
              }
            />
          </Field>
          <Field label="Связанные проекты, по одному в строке">
            <textarea
              className="input"
              value={draft.related.join('\n')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  related: e.target.value.split('\n').slice(0, 30),
                })
              }
            />
          </Field>
          <Field label="Источник описания (HTTPS)">
            <input
              className="input"
              type="url"
              value={draft.source}
              onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            />
          </Field>
          <Field label="Своя обложка или фото">
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </Field>
          {draft.cover_url && (
            <img src={draft.cover_url} className="h-32 w-32 rounded-xl object-cover" alt="Предпросмотр обложки" />
          )}
          <div className="flex flex-wrap gap-2">
            <Button busy={busy} variant="primary" onClick={() => void save()}>
              Сохранить для всех
            </Button>
            <Button disabled={busy} onClick={() => setDraft({ ...draft, cover_url: '' })}>
              Убрать свою обложку
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
