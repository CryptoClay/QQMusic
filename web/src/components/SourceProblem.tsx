import { Button } from './ui';

export function sourceErrorSummary(detail: string): string {
  const text = detail.toLowerCase();
  if (/cookies|сессия.*youtube/.test(text)) return 'Сессия YouTube недействительна. Владельцу сервера нужно обновить cookies.';
  if (/не робот|not a bot/.test(text)) return 'YouTube запросил подтверждение входа. Попробуйте другой источник.';
  if (/403|forbidden/.test(text)) return 'Источник отказал в выдаче аудио. Повторите загрузку или выберите другой файл.';
  if (/429|too many requests|ограничил запросы/.test(text)) return 'Источник временно ограничил запросы. Повторите позже.';
  if (/ssl|tls|unexpected_eof/.test(text)) return 'Не удалось установить защищённое соединение с источником. Повторите позже или выберите другой файл.';
  if (/timeout|timed out|время ожидания/.test(text)) return 'Источник не ответил вовремя. Повторите запрос или выберите другой источник.';
  if (/не найден|не наш|no match/.test(text)) return 'Подходящий файл не найден. Уточните запрос или выберите запись вручную.';
  if (/deezer|каталог/.test(text)) return 'Один из каталогов недоступен. Доступные результаты показаны ниже.';
  return 'Не удалось получить аудио из источника. Повторите запрос или выберите другой файл.';
}

export function SourceProblem({ detail, onRetry, onChoose, busy = false }: {
  detail: string; onRetry?: () => void; onChoose?: () => void; busy?: boolean;
}) {
  return <div className="rounded-xl border border-warn/25 bg-warn/10 p-4 text-sm" role="status">
    <p className="leading-6 text-warn">{sourceErrorSummary(detail)}</p>
    {(onRetry || onChoose) && <div className="mt-3 flex flex-wrap gap-2">
      {onRetry && <Button small icon="refresh" busy={busy} onClick={onRetry}>Повторить</Button>}
      {onChoose && <Button small variant="secondary" icon="search" onClick={onChoose}>Выбрать другой файл</Button>}
    </div>}
    <details className="mt-3 text-muted"><summary className="cursor-pointer text-xs">Технические подробности</summary>
      <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-all text-xs leading-5">{detail}</pre>
    </details>
  </div>;
}
