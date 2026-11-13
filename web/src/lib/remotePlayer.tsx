import { useEffect, useRef, useSyncExternalStore } from 'react';
import { request } from '../api/client';
import {
  getListenState,
  listeningDevice,
  next,
  pause,
  playListening,
  prev,
  resumeRemote,
  seek,
  setPlaybackGate,
  setVolume,
  toggle,
  useListen,
} from './listen';
import { listeningAccount } from './plays';
import { useSession } from './session';
import { useHubEvent } from './events';
import { checkSleep, cancelSleep, sleepState } from './sleep';
import { shortcutAction } from './playerActions';
import { toggleLike } from './stars';
import { toastError } from './ui';
import type { Song } from './community';
import { parseTime } from './format';

export const remoteDevice = `${listeningDevice()}-${crypto.randomUUID()}`;
let enabled = false;
let name = window.matchMedia('(pointer: coarse)').matches ? 'Телефон' : 'Компьютер';
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};
export function setRemoteAccess(value: boolean, label?: string) {
  enabled = value;
  if (label?.trim()) name = label.trim().slice(0, 100);
  emit();
  window.dispatchEvent(new Event('qqmusic:player-presence'));
}
export function useRemoteAccess() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => enabled,
  );
}
export const remoteName = () => name;
export interface PlayerDevice {
  device: string;
  name: string;
  enabled: boolean;
  online: boolean;
  seen_at: string;
  state: { track: Song | null; phase: string; position: number; duration: number; volume: number };
}
interface RemoteCommand {
  id: number;
  action: string;
  value?: number;
  queue: Song[];
  index: number;
  position: number;
  expires_at: string;
  expected_ref?: string | null;
}

export function PlayerRuntime() {
  const { me } = useSession();
  const phase = useListen((s) => s.phase);
  const ref = useListen((s) => s.track?.ref);
  const tick = useRef<((force?: boolean) => Promise<void>) | null>(null);
  useHubEvent('player', (data) => {
    if (data.device === remoteDevice) void tick.current?.(true);
  });
  useEffect(() => {
    void tick.current?.(true);
  }, [phase, ref]);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false,
      lastPresence = 0;
    const sendPresence = async () => {
      const state = getListenState();
      const track = state.track
        ? {
            ref: state.track.ref,
            title: state.track.title.slice(0, 512),
            artist: state.track.artist.slice(0, 512),
            duration_s: state.track.duration_s ?? null,
          }
        : null;
      await request('PUT', `/api/player/devices/${remoteDevice}`, {
        signal: controller.signal,
        json: {
          account: me.id,
          name,
          enabled,
          state: {
            track,
            phase: state.phase,
            position: Math.min(86400, Math.max(0, state.position)),
            duration: Math.min(86400, Math.max(0, state.duration)),
            volume: state.volume,
          },
        },
      });
      lastPresence = Date.now();
    };
    const apply = async (command: RemoteCommand) => {
      if (!enabled || listeningAccount() !== me.id || parseTime(command.expires_at).getTime() <= Date.now()) return;
      let status: 'done' | 'blocked' | 'failed' = 'done',
        result = 'Команда принята';
      try {
        const current = getListenState();
        if (command.action === 'seek' && command.expected_ref && command.expected_ref !== current.track?.ref)
          throw new Error('Трек уже сменился');
        if (!current.track && !['load', 'volume', 'pause'].includes(command.action))
          throw new Error('На устройстве не выбран трек');
        switch (command.action) {
          case 'play':
            playListening();
            break;
          case 'pause':
            pause();
            break;
          case 'next':
            if (!next()) throw new Error('Очередь закончилась');
            break;
          case 'prev':
            prev();
            break;
          case 'seek':
            seek(command.value!);
            break;
          case 'volume':
            setVolume(command.value!);
            break;
          case 'load':
            resumeRemote(command.queue, command.index, command.position);
            break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        if (listeningAccount() !== me.id) return;
        if (['play', 'load', 'next', 'prev'].includes(command.action) && getListenState().phase === 'paused') {
          status = 'blocked';
          result = 'Плеер ждёт нажатия «Слушать» на принимающем устройстве';
        } else if (getListenState().phase === 'error') {
          status = 'failed';
          result = 'Не удалось запустить аудио. Проверьте трек на принимающем устройстве';
        } else if (['resolving', 'loading'].includes(getListenState().phase))
          result = 'Команда принята, аудио загружается';
      } catch (error) {
        status = 'failed';
        result = (error as Error).message.slice(0, 200);
      }
      if (listeningAccount() !== me.id) return;
      await request('PUT', `/api/player/devices/${remoteDevice}/commands/${command.id}`, {
        signal: controller.signal,
        json: { status, result },
      });
      await sendPresence();
    };
    const cycle = async (force = false) => {
      if (busy || listeningAccount() !== me.id) return;
      busy = true;
      try {
        if (force || Date.now() - lastPresence > (enabled ? 5000 : 15000)) await sendPresence();
        if (enabled && listeningAccount() === me.id) {
          const response = await request<{ commands: RemoteCommand[] }>(
            'POST',
            `/api/player/devices/${remoteDevice}/poll`,
            { signal: controller.signal },
          );
          for (const command of response.commands) await apply(command);
        }
      } catch {
        /* Retry presence/commands quietly; never interrupt local audio. */
      } finally {
        busy = false;
      }
    };
    tick.current = cycle;
    void cycle(true);
    const interval = window.setInterval(() => void cycle(), 2000);
    const wake = () => {
      lastPresence = 0;
      checkSleep();
      void cycle(true);
    };
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('qqmusic:player-presence', wake);
    document.addEventListener('visibilitychange', wake);
    setPlaybackGate(checkSleep);
    const ended = () => cancelSleep();
    window.addEventListener('qqmusic:sleep-ended', ended);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !getListenState().track) return;
      const element = event.target instanceof Element ? event.target : null;
      if (
        element?.closest('input,textarea,select,button,a,[contenteditable],[role="slider"],[role="tab"]') ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      const action = shortcutAction(event.key, event.altKey || event.ctrlKey || event.metaKey, event.repeat);
      if (!action) return;
      event.preventDefault();
      const state = getListenState();
      switch (action) {
        case 'toggle':
          toggle();
          break;
        case 'next':
          next();
          break;
        case 'prev':
          prev();
          break;
        case 'back':
          seek(Math.max(0, state.position - 5));
          break;
        case 'forward':
          seek(Math.min(state.duration, state.position + 5));
          break;
        case 'louder':
          setVolume(state.volume + 0.05);
          break;
        case 'quieter':
          setVolume(state.volume - 0.05);
          break;
        case 'like':
          void toggleLike({ songId: state.info?.nd_song_id, ref: state.track!.ref, data: { ...state.track } }).catch(
            toastError,
          );
          break;
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      controller.abort();
      tick.current = null;
      window.clearInterval(interval);
      enabled = false;
      emit();
      cancelSleep();
      setPlaybackGate(null);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('qqmusic:player-presence', wake);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('qqmusic:sleep-ended', ended);
      window.removeEventListener('keydown', keydown);
    };
  }, [me.id]);
  useEffect(() => {
    if (sleepState().mode === 'track' && sleepState().ref !== ref) cancelSleep();
  }, [ref]);
  return null;
}
