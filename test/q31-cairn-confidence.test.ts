// test/q31-cairn-confidence.test.ts — Q31 attribution confidence & robustness.
//
// Covers: decisiveness (margin / entropy / label / thresholds), robustness
// (perturbation stability / flips / no-mutation / determinism / σ source),
// and the back-compat anchor (default output unchanged; confidence opt-in).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

import { decisiveness, robustness } from '../dist/confidence';
import type {
  AttributionCandidate, IncidentDefinition, RankedAttribution,
} from '../dist/types';

const T0 = 1_700_000_000;

// Minimal RankedAttribution with the given posteriors — decisiveness only
// reads ranked[i].posterior and .candidate.cause_id.
function rankedWith(posteriors: number[]): RankedAttribution {
  return {
    ranked: posteriors.map((p, i) => ({
      candidate: { cause_id: `c${i}`, cause_kind: 'deploy', timestamp_unix: T0, evidence_ref: '' },
      posterior: p,
      raw_score: p,
      kernel_value: 0,
      kind_prior: 0,
      evidence_boost: 1,
    })),
    suppressed: [],
    incident: { incident_id: 'x', onset_time_unix: T0, affected_signals: [] },
    config_used: {} as RankedAttribution['config_used'],
  };
}

// ── decisiveness ────────────────────────────────────────────────────────────

test('Q31 — single ranked candidate: margin 1, zero entropy, decisive', () => {
  const d = decisiveness(rankedWith([1]));
  assert.equal(d.top_margin, 1);
  assert.equal(d.entropy_normalized, 0);
  assert.equal(d.label, 'decisive');
});

test('Q31 — zero ranked candidates: no_candidates, margin 0', () => {
  const d = decisiveness(rankedWith([]));
  assert.equal(d.label, 'no_candidates');
  assert.equal(d.top_margin, 0);
  assert.equal(d.entropy_bits, 0);
});

test('Q31 — near-coin-flip (0.51/0.49): ambiguous, tiny margin, entropy≈1', () => {
  const d = decisiveness(rankedWith([0.51, 0.49]));
  assert.equal(d.label, 'ambiguous');
  assert.ok(Math.abs(d.top_margin - 0.02) < 1e-9);
  assert.ok(d.entropy_normalized > 0.99, `entropy_normalized ${d.entropy_normalized} should be ~1`);
});

test('Q31 — clear winner (0.8/0.2): decisive', () => {
  assert.equal(decisiveness(rankedWith([0.8, 0.2])).label, 'decisive');
});

test('Q31 — mid margin (0.6/0.3/0.1): contested', () => {
  assert.equal(decisiveness(rankedWith([0.6, 0.3, 0.1])).label, 'contested');
});

test('Q31 — custom thresholds relabel the same distribution', () => {
  const dist = rankedWith([0.6, 0.3, 0.1]); // margin 0.3
  assert.equal(decisiveness(dist).label, 'contested');             // default
  assert.equal(decisiveness(dist, { decisive: 0.25 }).label, 'decisive'); // lowered bar
  assert.deepEqual(decisiveness(dist, { decisive: 0.25 }).thresholds_used, { decisive: 0.25, contested: 0.15 });
});

test('Q31 — entropy of a uniform distribution: n=2 → 1 bit, n=4 → 2 bits (normalized 1.0)', () => {
  const d2 = decisiveness(rankedWith([0.5, 0.5]));
  assert.ok(Math.abs(d2.entropy_bits - 1) < 1e-9, `n=2 uniform entropy ${d2.entropy_bits} should be 1 bit`);
  assert.ok(Math.abs(d2.entropy_normalized - 1) < 1e-9);
  const d4 = decisiveness(rankedWith([0.25, 0.25, 0.25, 0.25]));
  assert.ok(Math.abs(d4.entropy_bits - 2) < 1e-9, `n=4 uniform entropy ${d4.entropy_bits} should be 2 bits`);
  assert.ok(Math.abs(d4.entropy_normalized - 1) < 1e-9);
});

// ── robustness ───────────────────────────────────────────────────────────────

function incident(overrides: Partial<IncidentDefinition> = {}): IncidentDefinition {
  return { incident_id: 'INC', onset_time_unix: T0, affected_signals: ['p99'], ...overrides };
}
function deploy(cause_id: string, ts: number): AttributionCandidate {
  return { cause_id, cause_kind: 'deploy', timestamp_unix: ts, evidence_ref: `ds:${cause_id}` };
}

test('Q31 — well-separated incident: top rank holds across all perturbations', () => {
  const cands = [deploy('A', T0 - 1000), { cause_id: 'E', cause_kind: 'env_change', timestamp_unix: T0 - 5 * 3600, evidence_ref: 'env' } as AttributionCandidate];
  const r = robustness(cands, incident());
  assert.equal(r.baseline_top_cause_id, 'A');
  assert.equal(r.top_stability, 1);
  assert.equal(r.flips.length, 0);
});

test('Q31 — fragile incident: a -2σ onset shift dethrones the top (flip surfaced)', () => {
  // A is closer to onset (top at baseline); a large negative onset shift moves
  // the alignment center past A so A is suppressed/out-aligned and B wins.
  const cands = [deploy('A', T0 - 1000), deploy('B', T0 - 2000)];
  const r = robustness(cands, incident(), {}, { onset_sigma_seconds: 1000 });
  assert.equal(r.baseline_top_cause_id, 'A');
  assert.ok(r.top_stability < 1, `expected fragility, got stability ${r.top_stability}`);
  assert.ok(r.flips.length >= 1, 'expected at least one flip');
  assert.ok(r.flips.some((f) => f.top_cause_id === 'B'), 'a flip should hand the top to B');
});

test('Q31 — perturbation direction is faithful: a negative-σ trial moves onset EARLIER', () => {
  // Candidate sits exactly at onset. Moving onset earlier (negative offset)
  // puts the candidate AFTER onset → suppressed → null top; moving onset later
  // (positive offset) keeps it before onset → it stays the top. This pins the
  // sign of the applied shift to its reported offset_seconds (kills a +/- flip).
  const r = robustness([deploy('A', T0)], incident(), {}, { onset_sigma_seconds: 1000 });
  const earlier = r.trials.find((t) => t.sigma_multiple === -1)!;
  const later = r.trials.find((t) => t.sigma_multiple === 1)!;
  assert.ok(earlier.offset_seconds < 0 && later.offset_seconds > 0);
  assert.equal(earlier.top_cause_id, null, 'onset moved earlier → candidate-at-onset is post-incident → no top');
  assert.equal(later.top_cause_id, 'A', 'onset moved later → candidate-at-onset stays the top');
});

test('Q31 — robustness does not mutate the caller incident', () => {
  const inc = incident({ engine_onset_estimate: { center_unix: T0, sigma_seconds: 600 } });
  robustness([deploy('A', T0 - 100)], inc);
  assert.equal(inc.onset_time_unix, T0);
  assert.equal(inc.engine_onset_estimate!.center_unix, T0);
});

test('Q31 — robustness is deterministic (replay-clean): two calls byte-identical', () => {
  const cands = [deploy('A', T0 - 1000), deploy('B', T0 - 2000)];
  const a = robustness(cands, incident(), {}, { onset_sigma_seconds: 1000 });
  const b = robustness(cands, incident(), {}, { onset_sigma_seconds: 1000 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('Q31 — onset σ falls back to engine_onset_estimate.sigma_seconds when opts omit it', () => {
  const inc = incident({ engine_onset_estimate: { center_unix: T0, sigma_seconds: 777 } });
  const r = robustness([deploy('A', T0 - 100)], inc);
  assert.equal(r.onset_sigma_seconds_used, 777);
});

// ── back-compat anchor (Q31 load-bearing constraint) ─────────────────────────

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'cairn.js');
const INCIDENT = path.join(ROOT, 'demos', 'cairn-incident.json');
const CANDIDATES = path.join(ROOT, 'demos', 'cairn-candidates.json');
const WALKTHROUGH = path.join(ROOT, 'demos', 'cairn-attribution-walkthrough.json');

test('Q31 — default CLI output omits the confidence field (opt-in)', () => {
  const out = execSync(`node ${CLI} ${INCIDENT} ${CANDIDATES} --json`, { encoding: 'utf8' });
  assert.equal(JSON.parse(out).confidence, undefined);
});

test('Q31 — --confidence adds decisiveness + robustness to the JSON envelope', () => {
  const out = execSync(`node ${CLI} ${INCIDENT} ${CANDIDATES} --json --confidence`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.ok(parsed.confidence, 'confidence block present');
  assert.ok(typeof parsed.confidence.decisiveness.label === 'string');
  assert.ok(parsed.confidence.robustness.top_stability >= 0 && parsed.confidence.robustness.top_stability <= 1);
});

test('Q31 — --check still verifies byte-identical against the v1 walkthrough fixture', () => {
  // Default (no --confidence) output must remain unchanged so the saved
  // replay fixture from v1 still matches. Throws (fails) on mismatch.
  execSync(`node ${CLI} ${INCIDENT} ${CANDIDATES} --check ${WALKTHROUGH}`, { encoding: 'utf8' });
});
