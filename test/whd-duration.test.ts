// test/whd-duration.test.ts — Whd duration formatter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../dist/duration';

test('Whd / AC-2 — compact forms', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(90), '1m 30s');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(5400), '1h 30m');
});

test('Whd / AC-2 — negative durations are prefixed with "-"', () => {
  assert.equal(formatDuration(-90), '-1m 30s');
  assert.equal(formatDuration(-3600), '-1h');
});

test('Whd / AC-3 — pure + deterministic: fractional truncates; same input → same output', () => {
  assert.equal(formatDuration(0.9), '0s');       // truncated, no throw
  assert.equal(formatDuration(89.9), '1m 29s');  // truncates to 89
  assert.equal(formatDuration(7325), formatDuration(7325)); // 2h 2m 5s, stable
  assert.equal(formatDuration(7325), '2h 2m 5s');
});
