import { useSyncExternalStore } from 'react';
import { toast } from './ui';
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let prompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  prompt = e as InstallPrompt;
  emit();
});
window.addEventListener('appinstalled', () => {
  prompt = null;
  emit();
});
export function usePwaInstall() {
  const canInstall = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => !!prompt,
  );
  const installed = window.matchMedia('(display-mode: standalone)').matches;
  return {
    canInstall,
    installed,
    install: async () => {
      const event = prompt;
      if (!event) return;
      prompt = null;
      emit();
      try {
        await event.prompt();
        await event.userChoice;
      } catch {
        toast('Не удалось открыть установку. Используйте меню браузера → «Установить приложение».', 'info');
      }
    },
  };
}
