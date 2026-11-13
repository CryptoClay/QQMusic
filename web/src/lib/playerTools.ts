import { useSyncExternalStore } from 'react';
export type PlayerTool = 'sleep' | 'devices' | 'shortcuts' | null;
let tool: PlayerTool = null;
const listeners = new Set<() => void>();
export function openPlayerTool(value: PlayerTool) {
  tool = value;
  for (const fn of listeners) fn();
}
export function usePlayerTool() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => tool,
  );
}
