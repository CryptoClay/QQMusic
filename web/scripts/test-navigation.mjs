import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

async function router() {
  const source = await readFile(new URL('../src/lib/router.tsx', import.meta.url), 'utf8');
  const calls = { events: 0, scrolls: 0, snapshots: 0, pushes: 0 };
  const location = { hash: '#/downloads' };
  const history = {
    state: { idx: 0 },
    pushState(state, _, hash) {
      this.state = state;
      location.hash = hash;
      calls.pushes++;
    },
    replaceState(state, _, hash) {
      this.state = state;
      location.hash = hash;
    },
  };
  const context = vm.createContext({
    URLSearchParams,
    Event,
    document: {
      hidden: false,
      startViewTransition() {
        calls.snapshots++;
        throw new Error('Page snapshots must not be used');
      },
    },
    window: {
      location,
      history,
      matchMedia: () => ({ matches: false }),
      dispatchEvent: () => calls.events++,
      scrollTo: () => calls.scrolls++,
    },
  });
  const core =
    source.slice(source.indexOf('export function parseHash'), source.indexOf('export function useRoute')) +
    source.slice(source.indexOf('const idx ='), source.indexOf('/** Go back'));
  vm.runInContext(
    stripTypeScriptTypes(
      'const ROUTE_EVENT="qqmusic:route";' + core.replace(/export /g, '') + ';globalThis.navigate=navigate;',
    ),
    context,
  );
  return { navigate: context.navigate, location, history, calls };
}

test('rapid page changes commit immediately in order without resizing page snapshots', async () => {
  const { navigate, location, history, calls } = await router();
  navigate('/library');
  assert.equal(location.hash, '#/library');
  navigate('/downloads');
  assert.equal(location.hash, '#/downloads');
  navigate('/library');
  assert.equal(location.hash, '#/library');
  assert.equal(history.state.idx, 3);
  assert.equal(calls.events, 3);
  assert.equal(calls.scrolls, 3);
  assert.equal(calls.snapshots, 0);
  navigate('/library');
  assert.equal(calls.events, 3);
  assert.equal(calls.pushes, 3);
});
test('search replacement keeps history and scroll while replacing the query', async () => {
  const { navigate, location, history, calls } = await router();
  navigate('/search');
  const scrolls = calls.scrolls;
  navigate('/search?q=music', { replace: true });
  assert.equal(location.hash, '#/search?q=music');
  assert.equal(history.state.idx, 1);
  assert.equal(calls.scrolls, scrolls);
  assert.equal(calls.snapshots, 0);
  navigate('/library', { replace: true });
  assert.equal(calls.scrolls, scrolls + 1);
  assert.equal(history.state.idx, 1);
});
