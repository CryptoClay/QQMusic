export interface LrcLine {
  time: number;
  text: string;
}
export function parseLrc(value: string): LrcLine[] {
  const offset = Number(value.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  return value
    .split(/\r?\n/)
    .flatMap((line) => {
      const times = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      const text = line.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
      return times
        .filter((m) => Number(m[2]) < 60)
        .map((m) => ({
          time: Math.max(0, Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3] ?? 0}`) - offset),
          text,
        }));
    })
    .sort((a, b) => a.time - b.time);
}
