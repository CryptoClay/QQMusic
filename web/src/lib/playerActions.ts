export function shortcutAction(key: string, modified: boolean, repeat: boolean): string | null {
  if (modified || repeat) return null;
  return (
    (
      {
        ' ': 'toggle',
        k: 'toggle',
        n: 'next',
        p: 'prev',
        ArrowLeft: 'back',
        ArrowRight: 'forward',
        ArrowUp: 'louder',
        ArrowDown: 'quieter',
        l: 'like',
      } as Record<string, string>
    )[key.length === 1 ? key.toLowerCase() : key] ?? null
  );
}
export function reorderQueue<T>(queue: readonly T[], current: number, from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return { queue, current };
  const result = [...queue];
  const [entry] = result.splice(from, 1);
  result.splice(to, 0, entry);
  const index =
    current === from
      ? to
      : from < current && to >= current
        ? current - 1
        : from > current && to <= current
          ? current + 1
          : current;
  return { queue: result, current: index };
}
