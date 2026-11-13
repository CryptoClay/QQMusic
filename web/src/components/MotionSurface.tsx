import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { mountReveals } from '../lib/reveal';

export function MotionSurface({ page, children }: { page: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) return mountReveals(ref.current);
  }, [page]);
  return (
    <div ref={ref} className="motion-surface">
      {children}
    </div>
  );
}
