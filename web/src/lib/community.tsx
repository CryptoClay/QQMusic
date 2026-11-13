import { useEffect, useRef } from 'react';
import { request } from '../api/client';
import { useHubEvent } from './events';
import { getListenState, listeningDevice, useListen } from './listen';
import { listeningAccount } from './plays';
import { useSession } from './session';
import { toast } from './ui';

export interface Song {
  ref: string;
  title: string;
  artist: string;
  duration_s?: number | null;
}
export interface Collection {
  id: number;
  name: string;
  owner_id: number;
  revision: number;
  archived: boolean;
  role: 'owner' | 'editor' | 'listener';
  items: Song[];
  members: { id: number; username: string; role: 'owner' | 'editor' | 'listener' }[];
}
export interface MusicRequest {
  id: number;
  user_id: number;
  username: string;
  kind: 'track' | 'album';
  artist: string;
  title: string;
  ref: string | null;
  status: string;
  note: string;
  batch_id: number | null;
}
export interface Inbox {
  unread: number;
  messages: { id: number; text: string; target: string; created_at: string; read: boolean }[];
}
export interface Snapshot {
  device: string;
  label: string;
  queue: Song[];
  index: number;
  position: number;
  updated_at: string;
}
export interface Policy {
  max_queue: number;
  storage_mb: number;
  upload_mb: number;
  parallel: number;
  queued: number;
  used_bytes: number;
}
export interface Group {
  id: number;
  name: string;
  revision: number;
  preferred_track_id: number | null;
  members: {
    track_id: number;
    kind: string;
    ref: string | null;
    title: string;
    artist: string;
    codec: string | null;
    bitrate_kbps: number | null;
    duration_s: number | null;
  }[];
}
export interface LibrarySong extends Song {
  id: number;
  codec?: string | null;
  bitrate_kbps?: number | null;
}
export interface SharedLink {
  id: number;
  name: string;
  url: string | null;
  access: string;
  expires_at: string;
  expired: boolean;
  revoked: boolean;
  track_count: number;
}
export const community = <T,>(path: string, signal?: AbortSignal) =>
  request<T>('GET', '/api/community' + path, { signal });

/** Save only this account's active browser player, never an empty state on another device. */
export function CommunitySync() {
  const { me } = useSession();
  const phase = useListen((s) => s.phase);
  const track = useListen((s) => s.track?.ref);
  const lastMessage = useRef<number | null>(null);
  const lastSaved = useRef<{ account: number; json: string } | null>(null);
  const saving = useRef(false);
  const refresh = async () => {
    try {
      const inbox = await community<Inbox>('/inbox');
      if (listeningAccount() !== me.id) return;
      const newest = inbox.messages[0]?.id ?? 0;
      if (lastMessage.current !== null && newest > lastMessage.current) {
        const incoming = inbox.messages.find((m) => m.id > lastMessage.current! && !m.read);
        if (incoming) toast(incoming.text, 'info', { label: 'Открыть', to: incoming.target });
      }
      lastMessage.current = newest;
    } catch {
      /* an inbox failure must never interrupt playback */
    }
  };
  useHubEvent('community', () => void refresh());
  useEffect(() => {
    lastMessage.current = null;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(timer);
  }, [me.id]);
  useEffect(() => {
    const save = async (leaving = false) => {
      if (saving.current || listeningAccount() !== me.id) return;
      const state = getListenState();
      if (!state.track || !state.queue.length || !['playing', 'paused', 'loading', 'ended'].includes(state.phase))
        return;
      const from = Math.max(0, state.index - 25);
      const queue = state.queue
        .slice(from, from + 200)
        .map((t) => ({ ref: t.ref, title: t.title, artist: t.artist, duration_s: t.duration_s ?? null }));
      if (queue.some((t) => !/^(nd|dz|hm|mb|file):\S+$/.test(t.ref))) return;
      const body = {
        account: me.id,
        label: window.matchMedia('(pointer: coarse)').matches ? 'Телефон · браузер' : 'Компьютер · браузер',
        queue,
        index: state.index - from,
        position: Math.max(0, state.position),
      };
      const json = JSON.stringify(body);
      if (lastSaved.current?.account === me.id && lastSaved.current.json === json) return;
      saving.current = true;
      try {
        if (leaving) {
          if (new TextEncoder().encode(json).byteLength >= 60000) return;
          const response = await fetch('/api/community/resume/' + listeningDevice(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: json,
            keepalive: true,
          });
          if (!response.ok) return;
        } else await request('PUT', '/api/community/resume/' + listeningDevice(), { json: body });
        lastSaved.current = { account: me.id, json };
      } catch {
        /* local resume remains available when offline */
      } finally {
        saving.current = false;
      }
    };
    void save();
    const timer = window.setInterval(() => void save(), 15000);
    const onHide = () => {
      void save(true);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
    };
  }, [me.id, phase, track]);
  return null;
}
