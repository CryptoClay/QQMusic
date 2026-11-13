import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDeadline, parseTime } from '../src/lib/format.ts';

test('future link expiry displays an absolute date instead of just now', () => {
  const value = fmtDeadline('2099-11-13T07:05:00');
  assert.match(value, /2099/);
  assert.doesNotMatch(value, /только что|назад/);
});

test('server timestamps without an offset are interpreted as UTC', () => {
  assert.equal(parseTime('2026-11-13T07:05:00').getTime(), parseTime('2026-11-13T07:05:00Z').getTime());
});
