const targets =
  '[data-reveal], [data-motion-list] > *, .grid > *, ul > li, h1, h2, .motion-surface > * > header, .motion-surface > * > form';

/** Prime visible content before paint; observe offscreen items once. Never animate page geometry. */
export function mountReveals(root: HTMLElement) {
  if (typeof Element.prototype.animate !== 'function') return () => {};
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const seen = new WeakSet<Element>();
  const watched = new Set<Element>();
  const animations = new Map<Element, Animation>();
  const cancel = (element: Element) => {
    animations.get(element)?.cancel();
    animations.delete(element);
  };
  const play = (elements: Element[]) => {
    let order = 0;
    for (const element of elements) {
      observer.unobserve(element);
      watched.delete(element);
      if (seen.has(element) || !root.contains(element)) continue;
      seen.add(element);
      if (media.matches || element.contains(document.activeElement)) continue;
      const animation = element.animate(
        [
          { opacity: 0, transform: 'translateY(16px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 540, delay: Math.min(order++, 5) * 42, fill: 'backwards', easing: 'cubic-bezier(.22,.68,.2,1)' },
      );
      animations.set(element, animation);
      void animation.finished.then(
        () => animations.delete(element),
        () => {},
      );
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      play(entries.filter((e) => e.isIntersecting).map((e) => e.target));
    },
    { threshold: 0, rootMargin: '0px 0px -8px 0px' },
  );
  const scan = (nodes: Element[]) => {
    if (media.matches) return;
    const candidates = new Set<Element>();
    for (const node of nodes) {
      if (node.matches(targets)) candidates.add(node);
      for (const element of node.querySelectorAll(targets)) candidates.add(element);
    }
    const visible: Element[] = [];
    // Read geometry in a batch before starting animations, including cached and async data.
    for (const element of candidates) {
      if (seen.has(element) || watched.has(element) || !root.contains(element)) continue;
      if (
        element.closest('[aria-hidden="true"], [role="status"], .skeleton') ||
        element.parentElement?.closest(targets)
      )
        continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom > 0 && rect.top < window.innerHeight - 8 && rect.right > 0 && rect.left < window.innerWidth)
        visible.push(element);
      else {
        watched.add(element);
        observer.observe(element);
      }
    }
    play(visible);
  };
  scan([root]);
  const changes = new MutationObserver((records) => {
    const added = records.flatMap((r) => Array.from(r.addedNodes)).filter((n): n is Element => n instanceof Element);
    scan(added);
    if (!records.some((r) => Array.from(r.removedNodes).some((n) => n instanceof Element))) return;
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
    observer.disconnect();
    watched.clear();
    for (const element of animations.keys()) cancel(element);
    if (!media.matches) scan([root]);
  };
  root.addEventListener('focusin', focus);
  media.addEventListener('change', preference);
  return () => {
    changes.disconnect();
    observer.disconnect();
    for (const element of animations.keys()) cancel(element);
    root.removeEventListener('focusin', focus);
    media.removeEventListener('change', preference);
  };
}
