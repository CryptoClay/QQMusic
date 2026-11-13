import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

test('audio graph applies EQ headroom, AGC, fade ramps and restores flat playback', async () => {
  const timers = [];
  globalThis.window = new EventTarget();
  window.setInterval = (fn) => {
    timers.push(fn);
    return 1;
  };
  globalThis.testPreferences = {
    eq_enabled: true,
    eq_gains: [6, 0, 0, 0, 0, -3],
    normalization: false,
    crossfade_s: 5,
  };
  class Param {
    value = 1;
    ramps = [];
    setTargetAtTime(value) {
      this.value = value;
    }
    setValueAtTime(value) {
      this.value = value;
    }
    cancelScheduledValues() {}
    linearRampToValueAtTime(value, time) {
      this.value = value;
      this.ramps.push({ value, time });
    }
  }
  class Node {
    connections = [];
    gain = new Param();
    frequency = new Param();
    Q = new Param();
    threshold = new Param();
    knee = new Param();
    ratio = new Param();
    attack = new Param();
    release = new Param();
    connect(node) {
      this.connections.push(node);
    }
    disconnect() {
      this.connections = [];
    }
    getFloatTimeDomainData(samples) {
      samples.fill(0.01);
    }
  }
  let ctx;
  globalThis.AudioContext = class {
    currentTime = 10;
    state = 'running';
    destination = new Node();
    gains = [];
    filters = [];
    sources = [];
    constructor() {
      ctx = this;
    }
    createMediaElementSource() {
      const node = new Node();
      this.sources.push(node);
      return node;
    }
    createBiquadFilter() {
      const node = new Node();
      this.filters.push(node);
      return node;
    }
    createGain() {
      const node = new Node();
      this.gains.push(node);
      return node;
    }
    createDynamicsCompressor() {
      return new Node();
    }
    createAnalyser() {
      return new Node();
    }
    async resume() {
      this.state = 'running';
    }
  };
  const source = stripTypeScriptTypes(
    await readFile(new URL('../src/lib/audioEffects.ts', import.meta.url), 'utf8'),
  ).replace(
    /import\s+\{\s*musicSettings\s*\}\s+from\s+["']\.\/music["'];?/,
    'const musicSettings=()=>globalThis.testPreferences;',
  );
  const effects = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const audio = { volume: 0.6 };
  effects.attachEffects(audio);
  effects.attachEffects(audio);
  assert.equal(ctx.sources.length, 1);
  assert.equal(ctx.filters.length, 6);
  assert.equal(ctx.filters[0].gain.value, 6);
  assert.equal(ctx.filters[5].gain.value, -3);
  assert.ok(Math.abs(ctx.gains[0].gain.value - 10 ** (-6 / 20)) < 0.000001);
  assert.equal(ctx.sources[0].connections.length, 1);
  effects.fadeLevel(audio, 0, 5);
  assert.deepEqual(ctx.gains[2].gain.ramps.at(-1), { value: 0, time: 15 });
  testPreferences.normalization = true;
  timers[0]();
  assert.equal(ctx.gains[1].gain.value, 4);
  testPreferences.eq_enabled = false;
  testPreferences.normalization = false;
  window.dispatchEvent(new Event('qqmusic-audio-settings'));
  assert.equal(ctx.gains[0].gain.value, 1);
  assert.equal(ctx.gains[1].gain.value, 1);
  assert.ok(ctx.filters.every((node) => node.gain.value === 0));
  effects.releaseEffects(audio);
  assert.equal(ctx.sources[0].connections.length, 0);
});
