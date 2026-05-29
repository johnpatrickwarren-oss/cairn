// test/q32-cairn-calibration.test.ts — Q32 calibration / backtesting harness.
//
// Covers: per-scenario rank / reciprocal-rank / Brier (incl. suppressed true
// cause), aggregate top-1 / top-k / MRR, reliability binning + ECE, empty-set
// guard, determinism, and the self-confirming-fixture guard (demo top-1 < 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

import { calibrate, scoreScenario, reliabilityBins } from '../dist/calibration';
import type {
  AttributionCandidate, LabeledScenario, ScenarioOutcome,
} from '../dist/types';

const T0 = 1_700_000_000;

function cand(cause_id: string, cause_kind: AttributionCandidate['cause_kind'], ts: number): AttributionCandidate {
  return { cause_id, cause_kind, timestamp_unix: ts, evidence_ref: cause_id };
}
function scenario(id: string, candidates: AttributionCandidate[], true_cause_id: string): LabeledScenario {
  return { incident: { incident_id: id, onset_time_unix: T0, affected_signals: ['x'] }, candidates, true_cause_id };
}

// ── per-scenario ─────────────────────────────────────────────────────────────

test('Q32 — perfect single scenario: true cause #1 → top1 1, mrr 1', () => {
  const r = calibrate([scenario('A', [cand('deploy:1', 'deploy', T0 - 120), cand('env:1', 'env_change', T0 - 8000)], 'deploy:1')]);
  assert.equal(r.top1_accuracy, 1);
  assert.equal(r.mrr, 1);
  assert.equal(r.per_scenario[0].true_cause_rank, 1);
});

test('Q32 — true cause at rank 2: reciprocal_rank 0.5, miss@1, hit@3', () => {
  // deploy is closer to onset (ranks #1); the true env_change is #2.
  const o = scoreScenario(scenario('B', [cand('deploy:1', 'deploy', T0 - 300), cand('env:1', 'env_change', T0 - 3600)], 'env:1'));
  assert.equal(o.true_cause_rank, 2);
  assert.equal(o.reciprocal_rank, 0.5);
  assert.equal(o.top_correct, false);
});

test('Q32 — suppressed true cause: rank null, reciprocal_rank 0, brier ≥ 1', () => {
  // chaos 90 min before onset underflows the 5-min chaos kernel → suppressed.
  const o = scoreScenario(scenario('C', [cand('deploy:1', 'deploy', T0 - 300), cand('chaos:1', 'chaos_experiment', T0 - 5400)], 'chaos:1'));
  assert.equal(o.true_cause_rank, null);
  assert.equal(o.reciprocal_rank, 0);
  assert.ok(o.brier >= 1, `brier ${o.brier} should be ≥1 (full miss on the true class)`);
});

test('Q32 — multi-class Brier on a 0.5/0.5 posterior equals 0.5', () => {
  // Two deploys equidistant from onset → posteriors 0.5/0.5. true is one of them.
  // Brier = (0.5-1)^2 + (0.5-0)^2 = 0.25 + 0.25 = 0.5.
  const o = scoreScenario(scenario('D', [cand('deploy:1', 'deploy', T0 - 600), cand('deploy:2', 'deploy', T0 - 600)], 'deploy:1'));
  assert.ok(Math.abs(o.brier - 0.5) < 1e-9, `brier ${o.brier} should be 0.5`);
});

// ── aggregates ───────────────────────────────────────────────────────────────

test('Q32 — top-k accuracy is monotone and matches the hand count', () => {
  const scenarios = [
    scenario('A', [cand('deploy:1', 'deploy', T0 - 120), cand('env:1', 'env_change', T0 - 8000)], 'deploy:1'), // hit@1
    scenario('B', [cand('deploy:1', 'deploy', T0 - 300), cand('env:1', 'env_change', T0 - 3600)], 'env:1'),     // hit@3 only (rank 2)
  ];
  const r = calibrate(scenarios, { k_values: [1, 3] });
  const top1 = r.topk_accuracy.find((t) => t.k === 1)!.accuracy;
  const top3 = r.topk_accuracy.find((t) => t.k === 3)!.accuracy;
  assert.equal(top1, 0.5);
  assert.equal(top3, 1);
  assert.ok(top3 >= top1);
});

test('Q32 — MRR equals the mean of reciprocal ranks (1 and 0.5 → 0.75)', () => {
  const r = calibrate([
    scenario('A', [cand('deploy:1', 'deploy', T0 - 120), cand('env:1', 'env_change', T0 - 8000)], 'deploy:1'), // rank 1
    scenario('B', [cand('deploy:1', 'deploy', T0 - 300), cand('env:1', 'env_change', T0 - 3600)], 'env:1'),     // rank 2
  ]);
  assert.ok(Math.abs(r.mrr - 0.75) < 1e-9, `mrr ${r.mrr} should be 0.75`);
});

// ── reliability + ECE ────────────────────────────────────────────────────────

function outcome(top_confidence: number, top_correct: boolean): ScenarioOutcome {
  return {
    incident_id: 'x', true_cause_id: 't', predicted_top_cause_id: 't',
    true_cause_rank: top_correct ? 1 : 2, true_cause_posterior: 0,
    top_confidence, top_correct, reciprocal_rank: 0, brier: 0,
  };
}

test('Q32 — reliability bins place confidences correctly and expose over-confidence', () => {
  // Two high-confidence predictions (one wrong) + one low-confidence correct.
  const bins = reliabilityBins([outcome(0.95, true), outcome(0.95, false), outcome(0.15, true)], 10);
  const hi = bins.find((b) => b.lower === 0.9)!;
  const lo = bins.find((b) => b.lower === 0.1)!;
  assert.equal(hi.count, 2);
  assert.ok(Math.abs(hi.mean_confidence - 0.95) < 1e-9);
  assert.equal(hi.empirical_accuracy, 0.5);            // 1 of 2 correct — over-confident
  assert.equal(lo.count, 1);
  assert.equal(lo.empirical_accuracy, 1);
});

test('Q32 — confidence exactly 1.0 lands in the last bin (no overflow)', () => {
  const bins = reliabilityBins([outcome(1.0, true)], 10);
  assert.equal(bins.length, 1);
  assert.equal(bins[0].lower, 0.9);
  assert.equal(bins[0].count, 1);
});

test('Q32 — ECE equals the hand-computed value on single-candidate scenarios', () => {
  // Single-candidate scenarios → posterior always 1.0 → all in the top bin.
  // 3 correct + 1 wrong ⇒ bin {mean_conf 1.0, emp_acc 0.75}; ECE = |1.0-0.75| = 0.25.
  const scenarios = [
    scenario('A', [cand('c1', 'deploy', T0 - 100)], 'c1'),
    scenario('B', [cand('c1', 'deploy', T0 - 100)], 'c1'),
    scenario('C', [cand('c1', 'deploy', T0 - 100)], 'c1'),
    scenario('D', [cand('c1', 'deploy', T0 - 100)], 'absent'), // true cause not among candidates → wrong
  ];
  const r = calibrate(scenarios);
  assert.equal(r.top1_accuracy, 0.75);
  assert.ok(Math.abs(r.ece - 0.25) < 1e-9, `ece ${r.ece} should be 0.25`);
});

// ── guards + determinism ─────────────────────────────────────────────────────

test('Q32 — empty scenario set: n 0, all metrics 0, no bins (no divide-by-zero)', () => {
  const r = calibrate([]);
  assert.equal(r.n, 0);
  assert.equal(r.top1_accuracy, 0);
  assert.equal(r.mrr, 0);
  assert.equal(r.brier_score, 0);
  assert.equal(r.ece, 0);
  assert.equal(r.reliability_bins.length, 0);
});

test('Q32 — deterministic (replay-clean): two identical calibrate calls byte-identical', () => {
  const s = [scenario('A', [cand('deploy:1', 'deploy', T0 - 120), cand('env:1', 'env_change', T0 - 8000)], 'deploy:1')];
  assert.equal(JSON.stringify(calibrate(s)), JSON.stringify(calibrate(s)));
});

// ── self-confirming-fixture guard ────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'cairn-calibrate.js');
const SCENARIOS = path.join(ROOT, 'demos', 'cairn-calibration-scenarios.json');

test('Q32 — CLI runs on the demo fixture; metrics are non-trivial (top-1 < 1)', () => {
  const out = execSync(`node ${CLI} ${SCENARIOS} --json`, { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.n, 5);
  assert.ok(r.top1_accuracy < 1, 'a calibration demo at 100% would be self-confirming');
  assert.ok(Math.abs(r.top1_accuracy - 0.6) < 1e-9, `demo top-1 ${r.top1_accuracy} should be 0.6 (3/5)`);
  assert.ok(Math.abs(r.mrr - 0.7) < 1e-9, `demo MRR ${r.mrr} should be 0.7`);
  assert.ok(r.ece > 0 && r.ece <= 1, `demo ECE ${r.ece} should be a real, non-zero gap`);
});
