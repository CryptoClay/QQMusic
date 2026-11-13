import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compatibleStorage } from '../src/lib/storage.ts';

function memory(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    get length() {
      return data.size;
    },
    key(i) {
      return [...data.keys()][i] ?? null;
    },
    getItem(k) {
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      data.set(k, String(v));
    },
    removeItem(k) {
      data.delete(k);
    },
    clear() {
      data.clear();
    },
  };
}

test('old queue, account settings and device identity remain readable; new values win', () => {
  const raw = memory({
    'hm-open-play:tab': 'queue',
    'hm-listen-session:42': 'position',
    'hm-listening-device': 'same-device',
  });
  const storage = compatibleStorage(() => raw);
  assert.equal(storage.getItem('qqmusic-open-play:tab'), 'queue');
  assert.equal(storage.getItem('qqmusic-listen-session:42'), 'position');
  assert.equal(storage.getItem('qqmusic-listen-session:43'), null);
  assert.equal(storage.getItem('qqmusic-listening-device'), 'same-device');
  storage.setItem('qqmusic-listening-device', 'new-device');
  assert.equal(raw.getItem('hm-listening-device'), null);
  assert.equal(storage.getItem('qqmusic-listening-device'), 'new-device');
});

test('outbox enumeration neither skips nor duplicates migrated events; acknowledgement removes both names', () => {
  const raw = memory({
    'hm-play-event:a': 'a',
    'hm-play-event:b': 'b',
    'qqmusic-play-event:b': 'b-new',
    'hm-play-event:c': 'c',
  });
  const storage = compatibleStorage(() => raw);
  const found = [];
  for (let i = 0; i < storage.length; i++) found.push(storage.getItem(storage.key(i)));
  assert.deepEqual(found, ['a', 'b-new', 'c']);
  storage.removeItem('qqmusic-play-event:b');
  assert.equal(storage.getItem('qqmusic-play-event:b'), null);
  assert.equal(raw.getItem('hm-play-event:b'), null);
});

test('quota failure keeps the original state readable and never deletes it', () => {
  const raw = memory({ 'hm-listen-session:7': 'saved' });
  raw.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const storage = compatibleStorage(() => raw);
  assert.equal(storage.getItem('qqmusic-listen-session:7'), 'saved');
  assert.throws(() => storage.setItem('qqmusic-listen-session:7', 'updated'));
  assert.equal(raw.getItem('hm-listen-session:7'), 'saved');
});
