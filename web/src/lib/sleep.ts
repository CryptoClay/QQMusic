import { useSyncExternalStore } from 'react';
import { pause, setStopAfterTrack } from './listen';
import { toast } from './ui';
type Sleep = { mode: 'off' | 'time' | 'track'; deadline: number; ref: string | null };
let state: Sleep = { mode: 'off', deadline: 0, ref: null };
let timer: number | undefined;
const listeners = new Set<() => void>();
function emit() {
  for (const fn of listeners) fn();
}
export const sleepState = () => state;
export function cancelSleep() {
  window.clearTimeout(timer);
  timer = undefined;
  state = { mode: 'off', deadline: 0, ref: null };
  setStopAfterTrack(false);
  emit();
}
export function checkSleep() {
  if (state.mode === 'time' && Date.now() >= state.deadline) {
    cancelSleep();
    pause();
    toast('Таймер сна: воспроизведение остановлено', 'info');
    return false;
  }
  return true;
}
export function scheduleSleep(minutes: number, ref: string) {
  cancelSleep();
  if (minutes === 0) {
    state = { mode: 'track', deadline: 0, ref };
    setStopAfterTrack(true);
  } else {
    state = { mode: 'time', deadline: Date.now() + minutes * 60000, ref };
    timer = window.setTimeout(checkSleep, minutes * 60000);
  }
  emit();
}
export function useSleep() {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, sleepState);
}
