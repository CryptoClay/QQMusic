import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

async function setup(reduced = false) {
  const calls = [];
  const hooks = {};
  let io, mutation;
  class Element {
    constructor(top = 0, candidate = true) {
      this.top = top;
      this.candidate = candidate;
      this.children = [];
      this.parentElement = null;
    }
    append(node) {
      node.parentElement = this;
      this.children.push(node);
      return node;
    }
    contains(node) {
      for (let p = node; p; p = p.parentElement) if (p === this) return true;
      return false;
    }
    matches() {
      return this.candidate;
    }
    closest(selector) {
      if (selector.includes('aria-hidden')) return null;
      for (let p = this; p; p = p.parentElement) if (p.candidate) return p;
      return null;
    }
    querySelectorAll() {
      return this.children.flatMap((n) => [...(n.candidate ? [n] : []), ...n.querySelectorAll()]);
    }
    getBoundingClientRect() {
      return { top: this.top, bottom: this.top + 40, left: 0, right: 200, width: 200, height: 40 };
    }
    animate(frames, options) {
      const animation = {
        frames,
        options,
        cancelled: false,
        finished: new Promise(() => {}),
        cancel() {
          this.cancelled = true;
        },
      };
      calls.push({ element: this, ...animation, animation });
      return animation;
    }
    addEventListener(event, fn) {
      hooks[event] = fn;
    }
    removeEventListener(event) {
      delete hooks[event];
    }
  }
  const media = {
    matches: reduced,
    addEventListener(_, fn) {
      this.changed = fn;
    },
    removeEventListener() {},
  };
  class IntersectionObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = new Set();
      io = this;
    }
    observe(e) {
      this.observed.add(e);
    }
    unobserve(e) {
      this.observed.delete(e);
    }
    disconnect() {
      this.observed.clear();
      this.disconnected = true;
    }
    emit(e) {
      this.cb([{ target: e, isIntersecting: true }]);
    }
  }
  class MutationObserver {
    constructor(cb) {
      this.cb = cb;
      mutation = this;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  const context = vm.createContext({
    Element,
    IntersectionObserver,
    MutationObserver,
    window: { innerHeight: 800, innerWidth: 1200, matchMedia: () => media },
    document: { activeElement: null },
  });
  const source = await readFile(new URL('../src/lib/reveal.ts', import.meta.url), 'utf8');
  vm.runInContext(stripTypeScriptTypes(source.replace(/export /g, '') + ';globalThis.mount=mountReveals;'), context);
  const root = new Element(0, false);
  return {
    Element,
    root,
    calls,
    media,
    hooks,
    mount: () => context.mount(root),
    get io() {
      return io;
    },
    get mutation() {
      return mutation;
    },
  };
}

test('cached and fast async content start before paint instead of skipping the entry window', async () => {
  const h = await setup();
  const first = h.root.append(new h.Element());
  const stop = h.mount();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].element, first);
  assert.equal(h.calls[0].frames[0].opacity, 0);
  assert.equal(h.calls[0].options.duration, 540);
  const asyncCard = h.root.append(new h.Element(100));
  h.mutation.cb([{ addedNodes: [asyncCard], removedNodes: [] }]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].element, asyncCard);
  h.mutation.cb([{ addedNodes: [asyncCard], removedNodes: [] }]);
  assert.equal(h.calls.length, 2);
  stop();
  assert.ok(h.calls.every((c) => c.animation.cancelled));
  assert.ok(h.io.disconnected && h.mutation.disconnected);
});
test('scroll reveals unseen rows once; nested targets and updates do not double animate', async () => {
  const h = await setup();
  const row = h.root.append(new h.Element(1000));
  row.append(new h.Element(1000));
  const stop = h.mount();
  assert.equal(h.calls.length, 0);
  assert.equal(h.io.observed.size, 1);
  row.top = 100;
  h.io.emit(row);
  assert.equal(h.calls.length, 1);
  h.io.emit(row);
  assert.equal(h.calls.length, 1);
  h.hooks.focusin({ target: row.children[0] });
  assert.equal(h.calls[0].animation.cancelled, true);
  stop();
});
test('reduced motion disables reveals and stagger stays bounded in large batches', async () => {
  const h = await setup(true);
  for (let i = 0; i < 16; i++) h.root.append(new h.Element(i * 40));
  const stop = h.mount();
  assert.equal(h.calls.length, 0);
  h.media.matches = false;
  h.media.changed();
  assert.equal(h.calls.length, 16);
  assert.equal(Math.max(...h.calls.map((c) => c.options.delay)), 210);
  h.media.matches = true;
  h.media.changed();
  assert.ok(h.calls.every((c) => c.animation.cancelled));
  stop();
});
