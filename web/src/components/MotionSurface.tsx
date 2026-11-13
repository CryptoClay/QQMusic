import { useLayoutEffect, useRef, type ReactNode } from 'react';

const targets = '[data-reveal], [data-motion-list] > *, .grid > *, ul > li, h1, h2';

/** Reveal once per mounted page, including async results. Content is never hidden by CSS. */
export function MotionSurface({ page, children }: { page: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || typeof Element.prototype.animate !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const seen = new WeakSet<Element>();
    const watched = new Set<Element>();
    const animations = new Map<Element, Animation>();
    let enter: Animation | null = null;
    const cancel = (element: Element) => {
      animations.get(element)?.cancel();
      animations.delete(element);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        let order = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting || media.matches) continue;
          const element = entry.target;
          observer.unobserve(element);
          watched.delete(element);
          seen.add(element);
          if (
            element.contains(document.activeElement) ||
            element.parentElement?.closest('[data-reveal], [data-motion-list] > *, .grid > *, ul > li')
          )
            continue;
          const animation = element.animate(
            [
              { opacity: 0.12, transform: 'translateY(9px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ],
            { duration: 360, fill: 'backwards', delay: Math.min(order++, 5) * 24, easing: 'cubic-bezier(.2,.7,.2,1)' },
          );
          animations.set(element, animation);
          void animation.finished.then(
            () => animations.delete(element),
            () => {},
          );
        }
      },
      { threshold: 0, rootMargin: '0px 0px -12px 0px' },
    );
    const scan = (node: Element) => {
      const elements = [...(node.matches(targets) ? [node] : []), ...node.querySelectorAll(targets)];
      for (const element of elements)
        if (!seen.has(element) && !watched.has(element) && !media.matches) {
          watched.add(element);
          observer.observe(element);
        }
    };
    scan(root);
    const changes = new MutationObserver((records) => {
      if (!records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n instanceof Element))) return;
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) scan(node);
      for (const element of watched)
        if (!root.contains(element)) {
          observer.unobserve(element);
          watched.delete(element);
        }
      for (const element of animations.keys()) if (!root.contains(element)) cancel(element);
    });
    changes.observe(root, { childList: true, subtree: true });
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      for (const element of animations.keys()) if (element.contains(event.target)) cancel(element);
    };
    const preference = () => {
      enter?.cancel();
      observer.disconnect();
      watched.clear();
      for (const element of animations.keys()) cancel(element);
      if (!media.matches) scan(root);
    };
    root.addEventListener('focusin', focus);
    media.addEventListener('change', preference);
    // Fallback for browsers without View Transitions, and browser Back/Forward.
    enter =
      !media.matches && !document.documentElement.classList.contains('route-transitioning')
        ? root.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' })
        : null;
    return () => {
      changes.disconnect();
      observer.disconnect();
      enter?.cancel();
      for (const element of animations.keys()) cancel(element);
      root.removeEventListener('focusin', focus);
      media.removeEventListener('change', preference);
    };
  }, [page]);
  return (
    <div ref={ref} className="motion-surface">
      {children}
    </div>
  );
}
