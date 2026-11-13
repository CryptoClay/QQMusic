/** Keep retries finite even if each reopened stream briefly reports `playing`. */
export const MAX_RECOVERY_ATTEMPTS = 2;
export function recoveryDelay(attempt: number): number | null {
  return attempt >= 0 && attempt < MAX_RECOVERY_ATTEMPTS ? [2000, 5000][attempt] : null;
}
export function playbackError(code: number, online: boolean): string {
  if (!online) return 'Нет связи с сетью. Продолжим после подключения; очередь и позиция сохранены.';
  if (code === 3) return 'Браузер не смог декодировать аудио. Попробуйте другую версию трека.';
  if (code === 4) return 'Файл недоступен или его формат не поддерживается браузером.';
  return 'Поток прервался. Нажмите «Повторить», чтобы продолжить с сохранённой позиции.';
}
export function swipeTrack(dx: number, dy: number, elapsed: number): 'next' | 'prev' | null {
  return elapsed <= 700 && Math.abs(dx) >= 65 && Math.abs(dx) > Math.abs(dy) * 1.6 ? (dx < 0 ? 'next' : 'prev') : null;
}
