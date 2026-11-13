import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { recoveryDelay, playbackError, swipeTrack } from '../src/lib/playbackRecovery.ts';

test('recovery is bounded and backs off instead of looping indefinitely', () => {
  assert.equal(recoveryDelay(0), 2000);
  assert.equal(recoveryDelay(1), 5000);
  assert.equal(recoveryDelay(2), null);
  assert.equal(recoveryDelay(-1), null);
  assert.match(playbackError(2, false), /Нет связи/);
  assert.match(playbackError(3, true), /декодировать/);
  assert.match(playbackError(4, true), /формат/);
});
test('track gestures ignore scrolling, short taps and slow drags', () => {
  assert.equal(swipeTrack(-90, 10, 200), 'next');
  assert.equal(swipeTrack(90, 10, 200), 'prev');
  assert.equal(swipeTrack(10, 100, 200), null);
  assert.equal(swipeTrack(90, 80, 200), null);
  assert.equal(swipeTrack(90, 0, 900), null);
  assert.equal(swipeTrack(20, 0, 100), null);
});

async function playerRecovery(online = true) {
  const source = await readFile(new URL('../src/lib/listen.ts', import.meta.url), 'utf8');
  const timers = new Map();
  const events = {};
  let sequence = 0;
  const context = vm.createContext({
    recoveryDelay,
    playbackError,
    navigator: { onLine: online },
    Date,
    window: {
      setTimeout(fn) {
        timers.set(++sequence, fn);
        return sequence;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      setInterval() {},
      addEventListener(name, fn) {
        events[name] = fn;
      },
    },
  });
  const core = source.slice(source.indexOf('let recoveryTimer:'), source.indexOf('/** `auto`: reached'));
  vm.runInContext(
    stripTypeScriptTypes(`
    let state = {track:{ref:'nd:song'},queue:[{ref:'nd:song'}],index:0,position:42,phase:'playing',error:null};
    let audio = {src:''}, pendingSeek = 0, played = null, errors = 0, plays = 0;
    function set(patch) { state = {...state, ...patch}; }
    function finishFade() {} function accrue() {} function checkpoint() {}
    function play() { plays++; } function reportEnd() { errors++; }
    function listenStreamUrl(ref) { return '/api/listen/stream?ref='+ref; }
    ${core}
    globalThis.driver = {fail:(code=2)=>recoverStream(audio,code),cancel:cancelRecovery,
      snapshot:()=>({state,pendingSeek,errors,plays,src:audio.src}),online:()=>{navigator.onLine=true;},
      change:()=>{cancelRecovery(); state={...state,track:{ref:'nd:another'},position:0};}};
  `),
    context,
  );
  return {
    driver: context.driver,
    timers,
    events,
    tick() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
}
test('actual player reopens at the saved position and stops after two attempts', async () => {
  const p = await playerRecovery();
  p.driver.fail();
  assert.equal(p.timers.size, 1);
  p.tick();
  assert.equal(p.driver.snapshot().pendingSeek, 42);
  assert.equal(p.driver.snapshot().state.index, 0);
  assert.match(p.driver.snapshot().src, /nd:song.*retry=/);
  p.driver.fail();
  p.tick();
  p.driver.fail();
  assert.equal(p.driver.snapshot().state.phase, 'error');
  assert.equal(p.driver.snapshot().plays, 2);
  assert.equal(p.driver.snapshot().errors, 1);
  assert.equal(p.timers.size, 0);
});
test('offline recovery waits for connection and respects cancellation or track changes', async () => {
  const p = await playerRecovery(false);
  p.driver.fail();
  assert.equal(p.timers.size, 0);
  p.driver.online();
  p.events.online();
  assert.equal(p.driver.snapshot().pendingSeek, 42);
  assert.equal(p.driver.snapshot().plays, 1);
  const paused = await playerRecovery(false);
  paused.driver.fail();
  paused.driver.cancel();
  paused.driver.online();
  paused.events.online();
  assert.equal(paused.driver.snapshot().plays, 0);
  const changed = await playerRecovery();
  changed.driver.fail();
  changed.driver.change();
  changed.tick();
  assert.equal(changed.driver.snapshot().plays, 0);
  assert.equal(changed.driver.snapshot().state.track.ref, 'nd:another');
});
test('decode and unsupported format failures do not repeatedly reopen the source', async () => {
  for (const code of [3, 4]) {
    const p = await playerRecovery();
    p.driver.fail(code);
    assert.equal(p.timers.size, 0);
    assert.equal(p.driver.snapshot().state.phase, 'error');
  }
});

test('one unsupported lock-screen action does not disable other controls', async () => {
  const source = await readFile(new URL('../src/lib/listen.ts', import.meta.url), 'utf8');
  const handlers = new Map();
  const seeks = [];
  const context = vm.createContext({
    navigator: { mediaSession: { setActionHandler(action, fn) {
      if (action === 'seekbackward') throw new Error('unsupported');
      handlers.set(action, fn);
    } } },
    MediaMetadata: class { constructor(data) { Object.assign(this, data); } },
    state: { position: 42, duration: 120, repeat: 'off' },
    seek: position => seeks.push(position), resume() {}, pause() {}, next() {}, prev() {}, hasNext: () => true,
  });
  const fn = source.slice(source.indexOf('function mediaSession(track:'), source.indexOf('/** Explicitly continue'));
  vm.runInContext(stripTypeScriptTypes(fn + '\nmediaSession({title:"Song",artist:"Band"});'), context);
  assert.ok(handlers.has('nexttrack'));
  assert.ok(handlers.has('previoustrack'));
  handlers.get('seekforward')({});
  handlers.get('seekto')({ seekTime: 77 });
  assert.deepEqual(seeks, [52, 77]);
});
