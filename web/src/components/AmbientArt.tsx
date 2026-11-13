import { useEffect, useRef } from 'react';

/** Decorative motion sleeps off screen and in background tabs; no animation-frame loop. */
export function AmbientArt({ variant }: { variant: 'wave' | 'mix' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let visible = false;
    const update = () => {
      element.dataset.moving = String(visible && !document.hidden);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return (
    <div ref={ref} aria-hidden="true" data-moving="false" className={`ambient-art ambient-${variant}`}>
      <span className="ambient-halo" />
      <span className="ambient-ribbon" />
      <span className="ambient-disc">
        <i />
        <b />
      </span>
      <span className="ambient-satellite" />
      {variant === 'wave' && (
        <span className="ambient-signal">
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${i * -0.17}s` }} />
          ))}
        </span>
      )}
    </div>
  );
}
