// test/q34-cairn-prior-sensitivity.test.ts — Q34 / Addition #34 prior-sensitivity diagnostic.
//
// Each test maps to an AC; no test may be self-confirming (it must FAIL if
// the production line it checks is broken). Tests run against dist/ via
// `node --test`; inputs use a fixed T0 constant (no clock, no RNG).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { priorSensitivity } from '../dist/prior-sensitivity';
import type { AttributionCandidate, IncidentDefinition, CairnScoringConfig } from '../dist/types';

const T0 = 1_700_000_000;
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'cairn.js');
const INCIDENT = path.join(ROOT, 'demos', 'cairn-incident.json');
const CANDIDATES = path.join(ROOT, 'demos', 'cairn-candidates.json');
const DEMO = path.join(ROOT, 'demos', 'cairn-prior-sensitivity-demo.json');
const WALKTHROUGH = path.join(ROOT, 'demos', 'cairn-attribution-walkthrough.json');

// Fixed incident used across unit tests.
function mkIncident(overrides: Partial<IncidentDefinition> = {}): IncidentDefinition {
  return {
    incident_id: 'INC-test-q34',
    onset_time_unix: T0,
    affected_signals: ['p99_latency'],
    ...overrides,
  };
}

// ── AC-1 / AC-2 ─────────────────────────────────────────────────────────────

test('Q34 / AC-1 AC-2 — priorSensitivity is a function; non-empty input returns the five typed fields', () => {
  // Verify the export is callable and the return shape matches AC-2 exactly.
  assert.equal(typeof priorSensitivity, 'function');

  const deploy: AttributionCandidate = {
    cause_id: 'deploy:test-a',
    cause_kind: 'deploy',
    timestamp_unix: T0 - 300,
    evidence_ref: 'ds-audit:test-a',
  };
  const result = priorSensitivity([deploy], mkIncident());

  // AC-2: the five fields exist with correct types.
  assert.ok('baseline_top_cause_id' in result);
  assert.ok('uniform_top_cause_id' in result);
  assert.ok('prior_driven' in result);
  assert.ok('baseline_top_posterior' in result);
  assert.ok('uniform_top_posterior' in result);

  // Exactly five keys — no extra fields.
  assert.equal(Object.keys(result).length, 5);

  // Types: string or null for cause IDs, boolean for prior_driven, numbers for posteriors.
  assert.ok(typeof result.baseline_top_cause_id === 'string' || result.baseline_top_cause_id === null);
  assert.ok(typeof result.uniform_top_cause_id === 'string' || result.uniform_top_cause_id === null);
  assert.equal(typeof result.prior_driven, 'boolean');
  assert.equal(typeof result.baseline_top_posterior, 'number');
  assert.equal(typeof result.uniform_top_posterior, 'number');

  // With one candidate the top must be non-null and both tops must agree (single candidate = no flip possible).
  assert.equal(result.baseline_top_cause_id, 'deploy:test-a');
  assert.equal(result.uniform_top_cause_id, 'deploy:test-a');
  assert.equal(result.prior_driven, false);
});

// ── AC-3 — prior-driven flip detected ───────────────────────────────────────

test('Q34 / AC-3 — prior-driven flip: deploy (prior=0.35) beats better-timed generic (prior=0.10) on baseline, loses under uniform', () => {
  // Scenario (mirrors demos/cairn-prior-sensitivity-demo.json against
  // demos/cairn-incident.json onset=1747700400):
  //
  //   deploy:   Δt=1200s,  σ=1800s,  K≈0.8007,  baseline_raw≈0.2802,  uniform_raw≈0.8007
  //   generic:  Δt=200s,   σ=3600s,  K≈0.9985,  baseline_raw≈0.0998,  uniform_raw≈0.9985
  //
  // Baseline → deploy #1 (prior advantage 0.35 vs 0.10).
  // Uniform  → generic #1 (better kernel wins once priors are equal).
  const ONSET = 1_747_700_400;
  const incident = mkIncident({ onset_time_unix: ONSET });

  const deploy: AttributionCandidate = {
    cause_id: 'deploy:checkout-svc',
    cause_kind: 'deploy',
    timestamp_unix: ONSET - 1200, // 20 min before onset
    evidence_ref: 'ds-audit:checkout-svc',
  };
  const generic: AttributionCandidate = {
    cause_id: 'external:flag-rollout',
    cause_kind: 'generic',
    timestamp_unix: ONSET - 200, // 200s before onset
    evidence_ref: 'flag-service:flag-rollout',
  };

  const result = priorSensitivity([deploy, generic], incident);

  // Baseline: deploy wins on prior.
  assert.equal(result.baseline_top_cause_id, 'deploy:checkout-svc',
    `baseline top should be the deploy (prior=0.35 carries it); got ${result.baseline_top_cause_id}`);
  // Uniform: generic wins on timing.
  assert.equal(result.uniform_top_cause_id, 'external:flag-rollout',
    `uniform top should be the generic (better-timed); got ${result.uniform_top_cause_id}`);

  // Flip detected → prior_driven must be true.
  assert.equal(result.prior_driven, true,
    'prior_driven should be true when the top candidate changes under uniform priors');

  // AC-3 identity: prior_driven === (baseline_top_cause_id !== uniform_top_cause_id).
  assert.equal(
    result.prior_driven,
    (result.baseline_top_cause_id as string | null) !== (result.uniform_top_cause_id as string | null),
    'prior_driven must equal (baseline_top_cause_id !== uniform_top_cause_id) by AC-3 definition',
  );

  // Sanity: posteriors are in (0, 1).
  assert.ok(result.baseline_top_posterior > 0 && result.baseline_top_posterior <= 1,
    `baseline posterior ${result.baseline_top_posterior} out of (0,1]`);
  assert.ok(result.uniform_top_posterior > 0 && result.uniform_top_posterior <= 1,
    `uniform posterior ${result.uniform_top_posterior} out of (0,1]`);
});

// ── AC-3 — robust (non-flip) case ───────────────────────────────────────────

test('Q34 / AC-3 — robust case: deploy close to onset dominates even under uniform priors (no false alarm)', () => {
  // Deploy at T0-300 (5 min lag vs σ=1800s → K≈0.986) and a generic at T0-1000
  // (σ=3600s → K≈0.962). Deploy wins on timing AND prior — no flip.
  const deploy: AttributionCandidate = {
    cause_id: 'deploy:tight',
    cause_kind: 'deploy',
    timestamp_unix: T0 - 300, // 5 min before onset; within 30-min σ
    evidence_ref: 'ds-audit:tight',
  };
  const generic: AttributionCandidate = {
    cause_id: 'external:loose',
    cause_kind: 'generic',
    timestamp_unix: T0 - 1000, // further out, weaker kernel
    evidence_ref: 'ext:loose',
  };

  const result = priorSensitivity([deploy, generic], mkIncident());

  // Both baseline and uniform should agree: deploy is #1.
  assert.equal(result.baseline_top_cause_id, 'deploy:tight',
    `baseline top should be deploy; got ${result.baseline_top_cause_id}`);
  assert.equal(result.uniform_top_cause_id, 'deploy:tight',
    `uniform top should still be deploy; got ${result.uniform_top_cause_id}`);

  // No flip → prior_driven must be false.
  assert.equal(result.prior_driven, false,
    'prior_driven should be false when top candidate does not change under uniform priors');

  // AC-3 identity holds in the false case too.
  assert.equal(
    result.prior_driven,
    result.baseline_top_cause_id !== result.uniform_top_cause_id,
    'prior_driven must equal (baseline_top_cause_id !== uniform_top_cause_id)',
  );
});

// ── AC-4 — empty set and all-suppressed ─────────────────────────────────────

test('Q34 / AC-4 — empty candidate set and all-suppressed: no throw, all nulls/false/0', () => {
  // Empty input.
  const resultEmpty = priorSensitivity([], mkIncident());
  assert.equal(resultEmpty.baseline_top_cause_id, null, 'empty: baseline_top_cause_id should be null');
  assert.equal(resultEmpty.uniform_top_cause_id, null, 'empty: uniform_top_cause_id should be null');
  assert.equal(resultEmpty.prior_driven, false, 'empty: prior_driven should be false');
  assert.equal(resultEmpty.baseline_top_posterior, 0, 'empty: baseline_top_posterior should be 0');
  assert.equal(resultEmpty.uniform_top_posterior, 0, 'empty: uniform_top_posterior should be 0');

  // All-suppressed: candidates all have timestamps AFTER onset + grace (120s > 60s default grace).
  const postIncident: AttributionCandidate = {
    cause_id: 'deploy:future',
    cause_kind: 'deploy',
    timestamp_unix: T0 + 120, // 120s after onset; suppressed by post_incident_timestamp
    evidence_ref: 'ds-audit:future',
  };
  const resultSuppressed = priorSensitivity([postIncident], mkIncident());
  assert.equal(resultSuppressed.baseline_top_cause_id, null, 'all-suppressed: baseline_top_cause_id should be null');
  assert.equal(resultSuppressed.uniform_top_cause_id, null, 'all-suppressed: uniform_top_cause_id should be null');
  assert.equal(resultSuppressed.prior_driven, false, 'all-suppressed: prior_driven should be false');
  assert.equal(resultSuppressed.baseline_top_posterior, 0, 'all-suppressed: baseline_top_posterior should be 0');
  assert.equal(resultSuppressed.uniform_top_posterior, 0, 'all-suppressed: uniform_top_posterior should be 0');
});

// ── AC-5 — read-only / no mutation ──────────────────────────────────────────

test('Q34 / AC-5 — priorSensitivity does not mutate candidates or config', () => {
  const candidates: AttributionCandidate[] = [
    {
      cause_id: 'deploy:ro-check',
      cause_kind: 'deploy',
      timestamp_unix: T0 - 600,
      evidence_ref: 'ds-audit:ro-check',
    },
    {
      cause_id: 'external:ro-generic',
      cause_kind: 'generic',
      timestamp_unix: T0 - 100,
      evidence_ref: 'ext:ro-generic',
    },
  ];
  const config: CairnScoringConfig = {
    kind_prior: { deploy: 0.35, generic: 0.10 },
  };

  // Deep-snapshot pre-call state via JSON round-trip.
  const candidatesSnapshot = JSON.parse(JSON.stringify(candidates));
  const configSnapshot = JSON.parse(JSON.stringify(config));

  priorSensitivity(candidates, mkIncident(), config);

  // Candidates array unchanged.
  assert.deepEqual(candidates, candidatesSnapshot,
    'candidates array must not be mutated by priorSensitivity');

  // Config unchanged, including the kind_prior sub-object.
  assert.deepEqual(config, configSnapshot,
    'config object must not be mutated by priorSensitivity');

  // Specifically: config.kind_prior is the caller's original object.
  assert.deepEqual(config.kind_prior, { deploy: 0.35, generic: 0.10 },
    'config.kind_prior must not be replaced or altered');
});

// ── AC-5 — purity / determinism + constant-immateriality ────────────────────

test('Q34 / AC-5 — deterministic (two identical calls produce deepEqual results); already-uniform config yields prior_driven=false', () => {
  // Use the prior-driven scenario to ensure priors matter in the first call.
  const ONSET = 1_747_700_400;
  const incident = mkIncident({ onset_time_unix: ONSET });
  const candidates: AttributionCandidate[] = [
    {
      cause_id: 'deploy:checkout-svc',
      cause_kind: 'deploy',
      timestamp_unix: ONSET - 1200,
      evidence_ref: 'ds-audit:checkout-svc',
    },
    {
      cause_id: 'external:flag-rollout',
      cause_kind: 'generic',
      timestamp_unix: ONSET - 200,
      evidence_ref: 'flag-service:flag-rollout',
    },
  ];

  // Determinism: two calls with identical inputs must be deepEqual.
  const r1 = priorSensitivity(candidates, incident);
  const r2 = priorSensitivity(candidates, incident);
  assert.deepEqual(r1, r2,
    'priorSensitivity must be deterministic — two calls with same inputs must be deepEqual');

  // Sanity-check that without any config the scenario IS prior-driven (the
  // normal scenario flips). This makes the next assertion non-trivial.
  assert.equal(r1.prior_driven, true,
    'baseline: the demo scenario should be prior_driven=true so the constant-immateriality test below is non-trivial');

  // Constant-immateriality: passing an already-uniform config must yield prior_driven=false.
  // Under config.kind_prior = { deploy: 1, generic: 1 } (already flat), the baseline
  // and uniform ranks use the same priors → same top → no flip.
  const flatConfig: CairnScoringConfig = {
    kind_prior: { deploy: 1, generic: 1 },
  };
  const rFlat = priorSensitivity(candidates, incident, flatConfig);
  assert.equal(rFlat.prior_driven, false,
    'an already-uniform config must yield prior_driven=false (flattening a flat prior is a no-op)');
  assert.equal(rFlat.baseline_top_cause_id, rFlat.uniform_top_cause_id,
    'when config is already uniform, baseline and uniform tops must agree');
});

// ── AC-6 — CLI opt-in flag ───────────────────────────────────────────────────

test('Q34 / AC-6 — CLI: --prior-sensitivity --json adds prior_sensitivity key; default output unchanged; --check unaffected', () => {
  // (a) With --prior-sensitivity --json: prior_sensitivity present, prior_driven===true for demo fixture.
  const outWithFlag = execSync(
    `node ${CLI} ${INCIDENT} ${DEMO} --prior-sensitivity --json`,
    { encoding: 'utf8' },
  );
  const parsedWithFlag = JSON.parse(outWithFlag);
  assert.ok('prior_sensitivity' in parsedWithFlag,
    '--prior-sensitivity --json must add a top-level prior_sensitivity key');
  assert.equal(typeof parsedWithFlag.prior_sensitivity, 'object',
    'prior_sensitivity must be an object');
  assert.equal(parsedWithFlag.prior_sensitivity.prior_driven, true,
    'demo fixture must produce prior_driven=true under --prior-sensitivity');
  // The base report fields are still present.
  assert.ok('cairn_report_version' in parsedWithFlag, 'report version should still be present');
  assert.ok('ranked' in parsedWithFlag, 'ranked array should still be present');
  assert.ok('suppressed' in parsedWithFlag, 'suppressed array should still be present');

  // (b) Default-output-unchanged guard: no --prior-sensitivity → no prior_sensitivity key.
  const outNoFlag = execSync(
    `node ${CLI} ${INCIDENT} ${CANDIDATES} --json`,
    { encoding: 'utf8' },
  );
  const parsedNoFlag = JSON.parse(outNoFlag);
  assert.ok(!('prior_sensitivity' in parsedNoFlag),
    'without --prior-sensitivity, JSON output must NOT contain a prior_sensitivity key');
  // Expected base shape preserved.
  assert.equal(parsedNoFlag.cairn_report_version, 'v1');
  assert.ok(Array.isArray(parsedNoFlag.ranked));
  assert.ok(Array.isArray(parsedNoFlag.suppressed));
  assert.ok('config_used' in parsedNoFlag);

  // (c) --check takes precedence; --prior-sensitivity is silently ignored under --check.
  if (!fs.existsSync(WALKTHROUGH)) {
    // First-run path: walkthrough not yet generated. Skip rather than fail.
    console.warn(`skip --check subtest — ${WALKTHROUGH} missing`);
  } else {
    // execSync throws if exit code is non-zero.
    execSync(
      `node ${CLI} ${INCIDENT} ${CANDIDATES} --check ${WALKTHROUGH} --prior-sensitivity`,
      { encoding: 'utf8' },
    );
  }
});
