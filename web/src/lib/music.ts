import { useSyncExternalStore } from 'react';
import { request } from '../api/client';

export type RadioMode = 'normal' | 'favorites' | 'discover';
export interface MusicPreferences {
  prefer_original: boolean;
  radio_mode: RadioMode;
  eq_enabled: boolean;
  eq_gains: number[];
  normalization: boolean;
  crossfade_s: number;
}
export const DEFAULT_MUSIC: MusicPreferences = {
  prefer_original: false,
  radio_mode: 'normal',
  eq_enabled: false,
  eq_gains: [0, 0, 0, 0, 0, 0],
  normalization: false,
  crossfade_s: 0,
};
let account: number | null = null;
let revision = 0;
let settings: MusicPreferences = { ...DEFAULT_MUSIC };
const subscribers = new Set<() => void>();
function emit() {
  for (const fn of subscribers) fn();
  window.dispatchEvent(new Event('qqmusic-audio-settings'));
}
export const musicSettings = () => settings;
export function useMusicSettings() {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    () => settings,
  );
}
export function restoreMusic(id: number | null) {
  if (account === id) return;
  account = id;
  const requested = ++revision;
  settings = { ...DEFAULT_MUSIC, eq_gains: [...DEFAULT_MUSIC.eq_gains] };
  if (id !== null) {
    try {
      const value = JSON.parse(localStorage.getItem(`qqmusic-settings:${id}`) ?? 'null');
      if (
        value &&
        Array.isArray(value.eq_gains) &&
        value.eq_gains.length === 6 &&
        value.eq_gains.every(
          (gain: unknown) => typeof gain === 'number' && Number.isFinite(gain) && gain >= -12 && gain <= 12,
        ) &&
        Number.isFinite(value.crossfade_s) &&
        value.crossfade_s >= 0 &&
        value.crossfade_s <= 10 &&
        ['normal', 'favorites', 'discover'].includes(value.radio_mode)
      )
        settings = {
          prefer_original: value.prefer_original === true,
          radio_mode: value.radio_mode,
          eq_enabled: value.eq_enabled === true,
          eq_gains: value.eq_gains,
          normalization: value.normalization === true,
          crossfade_s: value.crossfade_s,
        };
    } catch {}
  }
  emit();
  if (id !== null)
    void request<MusicPreferences>('GET', '/api/music/preferences')
      .then((value) => {
        if (account === id && revision === requested) {
          settings = value;
          emit();
        }
      })
      .catch(() => {});
}
export async function saveMusic(value: MusicPreferences) {
  const owner = account;
  if (owner === null) throw new Error('Требуется вход');
  const requested = ++revision;
  const result = await request<MusicPreferences>('PUT', '/api/music/preferences', { json: value });
  if (account === owner && revision === requested) {
    settings = result;
    try {
      localStorage.setItem(`qqmusic-settings:${owner}`, JSON.stringify(result));
    } catch {}
    emit();
  }
}

export { parseLrc } from './lrc';
