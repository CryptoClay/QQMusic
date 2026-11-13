import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc } from '../src/lib/lrc.ts';

test('timed lines support repeated timestamps, fractions and chronological order', () => {
  assert.deepEqual(parseLrc('[ar:Test]\n[01:02.50]Later\n[00:01.2][00:12.003]Repeat'), [
    { time: 1.2, text: 'Repeat' },
    { time: 12.003, text: 'Repeat' },
    { time: 62.5, text: 'Later' },
  ]);
});
test('plain text and invalid seconds do not become seek targets', () => {
  assert.deepEqual(parseLrc('Plain words\n[00:99]Invalid\n[00:03.00]'), [{ time: 3, text: '' }]);
});
test('offsets cannot create negative playback times', () => {
  assert.deepEqual(parseLrc('[offset:2000]\n[00:01.00]Start'), [{ time: 0, text: 'Start' }]);
  assert.deepEqual(parseLrc('[offset:-2000]\n[00:01.00]Start'), [{ time: 3, text: 'Start' }]);
});

test('bracketed lyric text is preserved', () => {
  assert.deepEqual(parseLrc('[00:01.00][Chorus] Sample'), [{ time: 1, text: '[Chorus] Sample' }]);
});
