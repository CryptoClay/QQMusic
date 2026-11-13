import { request, withQuery } from '../api/client';
import { useAsync, useInterval } from '../lib/hooks';

export function usePreparation(ref: string | undefined, waiting: boolean): string | null {
  const result = useAsync((signal) => request<{stage: string; progress: number | null}>('GET', withQuery('/api/listen/status', {ref}), {signal}), [ref], !!ref && waiting);
  useInterval(() => result.reload(true), ref && waiting ? 1500 : null);
  if (!waiting || !result.data) return null;
  const {stage, progress} = result.data;
  if (stage === 'ready') return 'Аудио готово · буферизация…';
  if (stage === 'preparing') return `Подготавливаем аудио${progress != null ? ` · ${Math.round(progress * 100)}%` : '…'}`;
  return 'Проверяем источник…';
}
