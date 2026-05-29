// test/wtn-topn.test.ts — Wtn top-N attribution slice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topCandidates } from '../dist/topn';
import type { RankedAttribution, ScoredCandidate } from '../dist/types';

function ranked(ids: string[]): RankedAttribution {
  return {
    ranked: ids.map((id, i): ScoredCandidate => ({
      candidate: { cause_id: id, cause_kind: 'deploy', timestamp_unix: 0, evidence_ref: id },
      posterior: 1 / (i + 1), raw_score: 1 / (i + 1), kernel_value: 0, kind_prior: 0, evidence_boost: 1,
    })),
    suppressed: [],
    incident: { incident_id: 'x', onset_time_unix: 0, affected_signals: [] },
    config_used: {} as RankedAttribution['config_used'],
  };
}

test('Wtn / AC-2 — returns the first n ranked candidates (posterior order preserved)', () => {
  const r = ranked(['a', 'b', 'c', 'd']);
  assert.deepEqual(topCandidates(r, 2).map((s) => s.candidate.cause_id), ['a', 'b']);
});

test('Wtn / AC-2 — n<=0 → []; n larger than the set → the whole set', () => {
  const r = ranked(['a', 'b']);
  assert.deepEqual(topCandidates(r, 0), []);
  assert.deepEqual(topCandidates(r, -1), []);
  assert.deepEqual(topCandidates(r, 99).map((s) => s.candidate.cause_id), ['a', 'b']);
});

test('Wtn / AC-3 — does not mutate the input ranked set', () => {
  const r = ranked(['a', 'b', 'c']);
  const out = topCandidates(r, 1);
  out.push(r.ranked[1]); // mutating the returned array must not affect the source
  assert.equal(r.ranked.length, 3);
});
