// test/q33-cairn-coverage.test.ts — Q33 candidate-coverage diagnostic.
//
// Verifies coverageDiagnostic across all acceptance criteria (AC-1…AC-6).
// Each test maps to one or more ACs; every assertion is designed to FAIL
// if the production line it guards is broken (no self-confirming tests).
//
// Tests run against dist/ via `node --test` per repo convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

import { coverageDiagnostic } from '../dist/coverage';
import type { CoverageDiagnostic } from '../dist/coverage';
import type {
  AttributionCandidate, IncidentDefinition, CairnScoringConfig,
} from '../dist/types';

// ── Fixture helpers ──────────────────────────────────────────────────────────

const T0 = 1_700_000_000; // arbitrary fixed onset (no wall-clock; NFR-3)

function makeIncident(overrides: Partial<IncidentDefinition> = {}): IncidentDefinition {
  return {
    incident_id: 'INC-q33-test',
    onset_time_unix: T0,
    affected_signals: ['p99_latency'],
    ...overrides,
  };
}

function makeCandidate(
  kind: AttributionCandidate['cause_kind'],
  ts: number,
): AttributionCandidate {
  return {
    cause_id: `${kind}-${ts}`,
    cause_kind: kind,
    timestamp_unix: ts,
    evidence_ref: `test-ref:${kind}@${ts}`,
  };
}

// ── T1: Shape / AC-1 + AC-2 ─────────────────────────────────────────────────

test('T1 / AC-1,AC-2 — coverageDiagnostic returns all five CoverageDiagnostic fields', () => {
  // If any field were missing or misspelled this test would fail via the 'in'
  // checks; if the return type were wrong the typeof checks would fail.
  const result = coverageDiagnostic([makeCandidate('deploy', T0 - 3600)], makeIncident());

  assert.ok('candidate_count' in result,       'missing field: candidate_count');
  assert.ok('earliest_lead_seconds' in result, 'missing field: earliest_lead_seconds');
  assert.ok('widest_sigma_seconds' in result,  'missing field: widest_sigma_seconds');
  assert.ok('adequately_covered' in result,    'missing field: adequately_covered');
  assert.ok('warning' in result,               'missing field: warning');

  assert.equal(typeof result.candidate_count,   'number',  'candidate_count must be number');
  assert.equal(typeof result.adequately_covered, 'boolean', 'adequately_covered must be boolean');
  assert.equal(result.candidate_count, 1);
});

// ── T2: Field semantics / AC-2 ───────────────────────────────────────────────

test('T2 / AC-2 — earliest_lead_seconds = onset − min(ts); widest_sigma = max σ among present kinds', () => {
  // deploy σ=1800s (30 min), chaos_experiment σ=300s (5 min).
  // widest = deploy (1800), NOT chaos (300).
  // Earliest ts = T0-5000 (deploy).  earliest_lead = T0 - (T0-5000) = 5000.
  const candidates = [
    makeCandidate('deploy',           T0 - 5000),
    makeCandidate('chaos_experiment', T0 - 2000),
  ];
  const result = coverageDiagnostic(candidates, makeIncident());

  assert.equal(result.candidate_count, 2);
  assert.equal(result.earliest_lead_seconds, 5000,
    'earliest_lead must equal onset − min(timestamp_unix)');
  // Breaking this assertion: if the code used 2000 instead of 5000 this fails.
  assert.equal(result.widest_sigma_seconds, 1800,
    'widest σ must be deploy (1800s), not chaos_experiment (300s)');
  // Breaking this: if code used 300 (wrong kind) or duplicated the default constant
  // with a stale value, this assertion catches it.
});

// ── T3: Wide window / AC-3 ───────────────────────────────────────────────────

test('T3 / AC-3 — adequate when lead ≥ 2×widest σ; exact-boundary (lead === 2×σ) is adequate', () => {
  // deploy σ=1800s; 2×1800 = 3600.

  // Strictly wider: lead 4000 > 3600 → covered.
  const r1 = coverageDiagnostic([makeCandidate('deploy', T0 - 4000)], makeIncident());
  assert.equal(r1.adequately_covered, true,
    'lead 4000 > 2×1800=3600 must be adequately_covered');
  assert.equal(r1.warning, null,
    'adequate coverage must have null warning');

  // Exact boundary: lead === 2×σ → adequate (≥, not >).
  // If the implementation used strict > the boundary would fail here.
  const r2 = coverageDiagnostic([makeCandidate('deploy', T0 - 3600)], makeIncident());
  assert.equal(r2.earliest_lead_seconds, 3600);
  assert.equal(r2.widest_sigma_seconds, 1800);
  assert.equal(r2.adequately_covered, true,
    'lead === 2×σ (exactly at boundary) must be adequately_covered (>= not >)');
  assert.equal(r2.warning, null);
});

// ── T4: Narrow window / AC-3 ─────────────────────────────────────────────────

test('T4 / AC-3 — narrow window → adequately_covered=false; warning mentions slow-burn and widening', () => {
  // deploy σ=1800s; 2×1800=3600. Lead 3000 < 3600 → narrow.
  // Swap lead to 3601 and adequately_covered would flip to true — proving the
  // assertion is not vacuously true.
  const result = coverageDiagnostic([makeCandidate('deploy', T0 - 3000)], makeIncident());

  assert.equal(result.adequately_covered, false,
    'lead 3000 < 2×1800=3600 must NOT be adequately_covered');
  assert.ok(result.warning !== null, 'narrow window must produce non-null warning');

  const w = result.warning!.toLowerCase();
  assert.ok(
    w.includes('slow') || w.includes('narrow'),
    `warning must reference slow-burn or narrow window; got: "${result.warning}"`,
  );
  assert.ok(
    w.includes('widen') || w.includes('lookback'),
    `warning must suggest widening the lookback; got: "${result.warning}"`,
  );

  // Also verify negative lead (all candidates post-onset) → always warns.
  const postOnset = coverageDiagnostic([makeCandidate('deploy', T0 + 1000)], makeIncident());
  assert.equal(postOnset.earliest_lead_seconds, -1000,
    'lead must be negative when candidate post-dates onset');
  assert.equal(postOnset.adequately_covered, false,
    'negative lead must not be adequately_covered');
});

// ── T5: Empty candidates / AC-4 ──────────────────────────────────────────────

test('T5 / AC-4 — empty array → no throw; count=0, nulls, not covered, "no candidates" warning', () => {
  // The call itself is the no-throw guard: if it throws the test framework
  // catches it and marks the test as failed (no try/catch needed).
  const result: CoverageDiagnostic = coverageDiagnostic([], makeIncident());

  assert.equal(result.candidate_count, 0,
    'candidate_count must be 0 for empty input');
  assert.equal(result.earliest_lead_seconds, null,
    'earliest_lead_seconds must be null for empty input');
  assert.equal(result.widest_sigma_seconds, null,
    'widest_sigma_seconds must be null for empty input');
  assert.equal(result.adequately_covered, false,
    'empty set must not be adequately_covered');
  assert.ok(result.warning !== null, 'empty set must produce a non-null warning');
  assert.ok(
    result.warning!.toLowerCase().includes('no candidate'),
    `warning must mention "no candidates"; got: "${result.warning}"`,
  );
});

// ── T6: Purity / determinism / AC-5 ──────────────────────────────────────────

test('T6 / AC-5 — pure+deterministic: identical calls deep-equal; frozen config unchanged after call', () => {
  const candidates = [
    makeCandidate('env_change', T0 - 10000),
    makeCandidate('deploy',     T0 -  5000),
  ];
  const incident = makeIncident();
  // Object.freeze proves no mutation attempt: Node would throw in strict mode
  // if the function tried to write to a frozen object.
  const config: CairnScoringConfig = Object.freeze({ grace_seconds: 120 }) as CairnScoringConfig;

  const r1 = coverageDiagnostic(candidates, incident, config);
  const r2 = coverageDiagnostic(candidates, incident, config);

  assert.deepEqual(r1, r2, 'identical calls must return deeply-equal results');
  assert.equal(JSON.stringify(r1), JSON.stringify(r2),
    'JSON serialization must be byte-identical (replay-clean)');

  // Config must be unmutated.
  assert.equal((config as CairnScoringConfig).grace_seconds, 120,
    'coverageDiagnostic must not mutate the config object');

  // Prove neither result depends on wall-clock: a third call must also equal.
  const r3 = coverageDiagnostic(candidates, incident, config);
  assert.deepEqual(r1, r3, 'third call must also be identical (no clock dependency)');
});

// ── T7: Config-override σ / AC-2 + AC-5 (Q33.3) ─────────────────────────────

test('T7 / AC-2,AC-5 — config-override σ honored; proves σ-map read from scorer, not hard-coded', () => {
  // env_change default σ = 6×3600 = 21600s.
  // Override to 9999.  If the code hard-coded the default the assertion breaks.
  const candidates = [makeCandidate('env_change', T0 - 5000)];
  const override: CairnScoringConfig = {
    kernel_sigma_seconds: { env_change: 9999 },
  };

  const withOverride = coverageDiagnostic(candidates, makeIncident(), override);
  assert.equal(withOverride.widest_sigma_seconds, 9999,
    'widest_sigma_seconds must reflect the config-override, not the hard-coded default');

  // Cross-check: without override, env_change σ = 21600.
  const withDefault = coverageDiagnostic(candidates, makeIncident());
  assert.equal(withDefault.widest_sigma_seconds, 21600,
    'default env_change σ must be 21600');

  // Override to a value (2000) where the same lead (5000) flips from
  // narrow to adequate — proving the override actually gates coverage logic.
  const tinyOverride: CairnScoringConfig = {
    kernel_sigma_seconds: { env_change: 2000 },
  };
  const withTiny = coverageDiagnostic(candidates, makeIncident(), tinyOverride);
  assert.equal(withTiny.widest_sigma_seconds, 2000);
  // 2×2000=4000 ≤ 5000 → adequate
  assert.equal(withTiny.adequately_covered, true,
    'with σ=2000, lead 5000 ≥ 2×2000=4000 → adequately_covered must be true');
  // With default 21600: 2×21600=43200 > 5000 → NOT adequate
  assert.equal(withDefault.adequately_covered, false,
    'with default σ=21600, lead 5000 < 2×21600=43200 → must NOT be adequately_covered');
});

// ── T8: CLI integration / AC-6 ───────────────────────────────────────────────

test('T8 / AC-6 — CLI: default output has no coverage key; --coverage adds it; demo fixture warns', () => {
  const ROOT      = path.resolve(__dirname, '..');
  const CLI       = path.join(ROOT, 'tools', 'cairn.js');
  const INCIDENT  = path.join(ROOT, 'demos', 'cairn-incident.json');
  const CANDIDATES = path.join(ROOT, 'demos', 'cairn-candidates.json');

  // T8(a): default (no --coverage) → no 'coverage' key.
  // If byte-identity were broken by the new code, the 'coverage' key would
  // appear here and the assertion would fail.
  const defaultRaw = execSync(`node ${CLI} ${INCIDENT} ${CANDIDATES} --json`, { encoding: 'utf8' });
  const defaultReport = JSON.parse(defaultRaw);
  assert.equal('coverage' in defaultReport, false,
    'default --json output must NOT include a coverage key (byte-identical to pre-Q33)');
  // Required keys should still be present (regression guard).
  assert.equal(defaultReport.cairn_report_version, 'v1');
  assert.ok(Array.isArray(defaultReport.ranked));
  assert.ok(Array.isArray(defaultReport.suppressed));

  // T8(b): with --coverage → 'coverage' key present with all five fields.
  const covRaw = execSync(`node ${CLI} ${INCIDENT} ${CANDIDATES} --json --coverage`, { encoding: 'utf8' });
  const covReport = JSON.parse(covRaw);
  assert.ok('coverage' in covReport,
    '--coverage flag must add coverage key to JSON output');
  const cov: CoverageDiagnostic = covReport.coverage;
  assert.ok('candidate_count'       in cov, 'coverage must have candidate_count');
  assert.ok('earliest_lead_seconds' in cov, 'coverage must have earliest_lead_seconds');
  assert.ok('widest_sigma_seconds'  in cov, 'coverage must have widest_sigma_seconds');
  assert.ok('adequately_covered'    in cov, 'coverage must have adequately_covered');
  assert.ok('warning'               in cov, 'coverage must have warning');

  // T8(c): Demo fixture is the slow-burn blind-spot case (S14 / Q33):
  //   onset=1747700400, env_change ts=1747686000 → lead=14400s
  //   env_change σ=21600s; 2×21600=43200 > 14400 → NOT covered → warns.
  // If this assertion passes vacuously the system is self-confirming; it
  // must FAIL if adequately_covered were accidentally set to true.
  assert.equal(cov.adequately_covered, false,
    'demo fixture: earliest_lead 14400 < 2×env_change_σ 43200 → must NOT be adequately_covered');
  assert.ok(cov.warning !== null,
    'demo fixture must carry a non-null warning (narrow-window blind spot)');
  assert.equal(cov.earliest_lead_seconds, 14400,
    'demo: onset 1747700400 − env_change ts 1747686000 = 14400s');
  assert.equal(cov.widest_sigma_seconds, 21600,
    'demo: widest σ is env_change default = 21600s');
  assert.equal(cov.candidate_count, 4,
    'demo fixture has 4 candidates (deploy, chaos, env_change, shard)');
});
