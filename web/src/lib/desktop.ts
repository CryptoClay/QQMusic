import { useSyncExternalStore } from 'react';
import { STANDALONE } from './embedded';

/** A wide standalone browser, including computers with touch screens. */
const QUERY = '(min-width: 1024px)';

const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null;

/** The desktop-only extras (the living «Моя волна» hero): a plain browser (`STANDALONE`, never inside the app) on a
 * wide screen. Read it again on every render — the window can be resized or moved to another screen. */
export const isDesktop = (): boolean => STANDALONE && !!mql?.matches;

const subscribe = (cb: () => void) => {
  mql?.addEventListener('change', cb);
  return () => mql?.removeEventListener('change', cb);
};

/** `isDesktop()` that re-renders the component when it changes (no reload needed). */
export const useDesktop = (): boolean => useSyncExternalStore(subscribe, isDesktop, () => false);
