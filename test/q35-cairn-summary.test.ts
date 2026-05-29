// test/q35-cairn-summary.test.ts — Q35 attribution-summary line.
//
// Verifies attributionSummary across all acceptance criteria (AC-1…AC-5).
// Each test maps to one or more ACs; every assertion is designed to FAIL
// if the production line it guards is broken (no self-confirming tests).
//
// Tests run against dist/ via `node --test` per repo convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

import { attributionSummary } from '../dist/summary';
import type { AttributionSummary } from '../dist/summary';
import { rankCandidates } from '../dist/score';
import type {
  AttributionCandidate, IncidentDefinition,
} from '../dist/types';

// ── Fixture helpers ──────────────────────────────────────────────────────────

const T0 = 1_700_000_000; // arbitrary fixed onset (no wall-clock; NFR-3)

function makeIncident(overrides: Partial<IncidentDefinition> = {}): IncidentDefinition {
  return {
    incident_id: 'INC-q35-test',
    onset_time_unix: T0,
    affected_signals: ['p99_latency'],
    ...overrides,
  };
}

function makeCandidate(
  kind: AttributionCandidate['cause_kind'],
  ts: number,
  causeId?: string,
): AttributionCandidate {
  return {
    cause_id: causeId ?? `${kind}:test-${ts}`,
    cause_kind: kind,
    timestamp_unix: ts,
    evidence_ref: `test-ref:${kind}@${ts}`,
  };
}

// ── T1: Module shape / AC-1, AC-2 ───────────────────────────────────────────

test('T1 / AC-1,AC-2 — attributionSummary is a function and returns all five AttributionSummary fields', () => {
  // AC-1: the export is callable.
  assert.equal(typeof attributionSummary, 'function',
    'attributionSummary must be exported as a function');

  // Use rankCandidates to produce a real RankedAttribution (not a hand-mock).
  const ranked = rankCandidates(
    [makeCandidate('deploy', T0 - 600)],  // 10 min before onset — well within 30 min σ
    makeIncident(),
  );
  const result: AttributionSummary = attributionSummary(ranked);

  // AC-2: all five keys present with correct types.
  assert.ok('headline' in result,         'missing field: headline');
  assert.ok('top_cause_id' in result,     'missing field: top_cause_id');
  assert.ok('top_posterior' in result,    'missing field: top_posterior');
  assert.ok('ranked_count' in result,     'missing field: ranked_count');
  assert.ok('suppressed_count' in result, 'missing field: suppressed_count');

  assert.equal(typeof result.headline,         'string',  'headline must be a string');
  assert.equal(typeof result.ranked_count,     'number',  'ranked_count must be a number');
  assert.equal(typeof result.suppressed_count, 'number',  'suppressed_count must be a number');
  assert.equal(typeof result.top_posterior,    'number',  'top_posterior must be a number');

  // top_cause_id is string | null — verify it is a string for a non-empty ranked set.
  assert.ok(
    result.top_cause_id === null || typeof result.top_cause_id === 'string',
    'top_cause_id must be string | null',
  );
  assert.notEqual(result.top_cause_id, null,
    'top_cause_id must be non-null when ranked is non-empty');

  // ranked_count should reflect the actual ranked array length.
  assert.equal(result.ranked_count, ranked.ranked.length,
    'ranked_count must equal ranked.ranked.length');
  assert.equal(result.suppressed_count, ranked.suppressed.length,
    'suppressed_count must equal ranked.suppressed.length');
});

// ── T2: Headline format + canonical fixture numbers / AC-2 ──────────────────

test('T2 / AC-2 — headline matches exact template; pins canonical demo fixture at 80.7% (3 ranked, 1 suppressed)', () => {
  // Reproduce the canonical demo scenario (cairn-candidates.json + cairn-incident.json).
  // Incident onset = 1747700400.
  const ONSET = 1747700400;
  const demoIncident: IncidentDefinition = {
    incident_id: 'INC-2026-05-19-001',
    onset_time_unix: ONSET,
    affected_signals: ['p99_latency', 'downstream_err'],
  };

  // Deploy: ts=1747699320, verdict=extend, alpha_consumed/budget → ratio≈0.9 (>0.05 so no sharpening).
  const deploy: AttributionCandidate = {
    cause_id: 'deploy:model-weights-v2026-05-19-001',
    cause_kind: 'deploy',
    timestamp_unix: 1747699320,
    evidence_ref: 'ds-audit:model-weights-v2026-05-19-001@1747699320#v2026-05-19-mosaic',
    metadata: { ds_verdict: 'extend', ds_alpha_consumed_ratio: 0.9 },
  };

  // Tessera shard event: ts=1747698900
  const shardEvent: AttributionCandidate = {
    cause_id: 'tessera-shard:tessera-vg-2026-05-19-22-shard-04',
    cause_kind: 'shard_event',
    timestamp_unix: 1747698900,
    evidence_ref: 'tessera-verdict-group:tessera-vg-2026-05-19-22-shard-04',
  };

  // Anvil chaos: ts=1747695000 — should be suppressed (kernel_underflow: 90 min lag, 5 min σ).
  const chaos: AttributionCandidate = {
    cause_id: 'chaos:anvil-chaos-2026-05-19-3pm',
    cause_kind: 'chaos_experiment',
    timestamp_unix: 1747695000,
    evidence_ref: 'anvil:anvil-chaos-2026-05-19-3pm',
  };

  // Env change: ts=1747686000 (4 hr before, env_change σ=6hr → still ranked).
  const envChange: AttributionCandidate = {
    cause_id: 'env:infra-cluster-rolling-restart-2026-05-19',
    cause_kind: 'env_change',
    timestamp_unix: 1747686000,
    evidence_ref: 'infra-ops:infra-cluster-rolling-restart-2026-05-19',
  };

  const ranked = rankCandidates([deploy, chaos, envChange, shardEvent], demoIncident);

  // Sanity: chaos is suppressed (kernel_underflow), so 3 ranked + 1 suppressed.
  assert.equal(ranked.ranked.length, 3, 'demo fixture must have 3 ranked candidates');
  assert.equal(ranked.suppressed.length, 1, 'demo fixture must have 1 suppressed candidate');

  const result = attributionSummary(ranked);

  // Counts must match array lengths.
  assert.equal(result.ranked_count, 3);
  assert.equal(result.suppressed_count, 1);

  // Top candidate is the deploy.
  assert.equal(result.top_cause_id, 'deploy:model-weights-v2026-05-19-001',
    'top_cause_id must equal ranked[0].candidate.cause_id');
  assert.equal(result.top_posterior, ranked.ranked[0].posterior,
    'top_posterior must equal ranked[0].posterior (full float precision)');

  // Percentage formatted with one decimal, same formula as cairn.js:124.
  const expectedPct = (result.top_posterior * 100).toFixed(1);
  assert.equal(expectedPct, '80.7',
    `canonical deploy posterior rounds to 80.7%; got ${expectedPct}`);

  // Headline must match the exact AC-2 template.
  const expectedHeadline =
    `Top: deploy:model-weights-v2026-05-19-001 at 80.7% (3 ranked, 1 suppressed)`;
  assert.equal(result.headline, expectedHeadline,
    `headline must match exact AC-2 exemplar; got: "${result.headline}"`);
  // Breaking any part of the template (wrong separator, missing %, wrong order)
  // would fail the above equality — this test is not self-confirming.
});

// ── T3: Empty ranked set / AC-3 ─────────────────────────────────────────────

test('T3 / AC-3 — empty ranked set: no throw, top_cause_id null, top_posterior 0, "no candidates ranked" headline', () => {
  const inc = makeIncident();

  // Empty input → ranked.ranked = [], ranked.suppressed = [].
  const emptyRanked = rankCandidates([], inc);
  // The call itself is the no-throw guard: if it throws the framework catches
  // it and marks the test failed (no try/catch needed).
  const result = attributionSummary(emptyRanked);

  assert.equal(result.top_cause_id, null,       'empty set: top_cause_id must be null');
  assert.equal(result.top_posterior, 0,         'empty set: top_posterior must be 0');
  assert.equal(result.ranked_count, 0,          'empty set: ranked_count must be 0');
  assert.equal(result.suppressed_count, 0,      'empty set: suppressed_count must be 0');
  assert.ok(
    result.headline.toLowerCase().includes('no candidates ranked'),
    `empty set: headline must include "no candidates ranked"; got: "${result.headline}"`,
  );

  // All-suppressed case: chaos experiment 90 min before onset (5-min σ → kernel_underflow).
  // ranked is empty but suppressed has entries.
  const chaos: AttributionCandidate = {
    cause_id: 'chaos:test-underflow',
    cause_kind: 'chaos_experiment',
    timestamp_unix: T0 - 90 * 60, // 90 minutes before onset — well beyond 5-min σ
    evidence_ref: 'test:chaos',
  };
  const allSuppressedRanked = rankCandidates([chaos], inc);

  assert.equal(allSuppressedRanked.ranked.length, 0,
    'all-suppressed fixture: ranked must be empty');
  assert.equal(allSuppressedRanked.suppressed.length, 1,
    'all-suppressed fixture: suppressed must have one entry');

  const allSupResult = attributionSummary(allSuppressedRanked);

  assert.equal(allSupResult.top_cause_id, null,
    'all-suppressed: top_cause_id must be null');
  assert.equal(allSupResult.top_posterior, 0,
    'all-suppressed: top_posterior must be 0');
  assert.equal(allSupResult.ranked_count, 0,
    'all-suppressed: ranked_count must be 0');
  assert.equal(allSupResult.suppressed_count, 1,
    'all-suppressed: suppressed_count must equal number of suppressed entries');
  assert.ok(
    allSupResult.headline.toLowerCase().includes('no candidates ranked'),
    `all-suppressed: headline must include "no candidates ranked"; got: "${allSupResult.headline}"`,
  );
  // The headline must reflect the non-zero suppressed count.
  assert.ok(
    allSupResult.headline.includes('1 suppressed'),
    `all-suppressed: headline must show "1 suppressed"; got: "${allSupResult.headline}"`,
  );
  // Confirm suppressed_count is independent of ranked_count:
  // ranked_count===0 but suppressed_count===1 proves the two fields are computed separately.
  assert.notEqual(allSupResult.ranked_count, allSupResult.suppressed_count,
    'suppressed_count must be independent of ranked_count when only some candidates are suppressed');
});

// ── T4: Purity + read-only / AC-4 ───────────────────────────────────────────

test('T4 / AC-4 — pure + deterministic: two calls deepEqual; RankedAttribution not mutated', () => {
  const candidates = [
    makeCandidate('deploy',     T0 - 900,  'deploy:t4-main'),    // 15 min before onset
    makeCandidate('env_change', T0 - 7200, 'env:t4-background'), // 2 hr before onset
  ];
  const ranked = rankCandidates(candidates, makeIncident());

  // Snapshot the RankedAttribution before calling attributionSummary.
  const snapshotBefore = JSON.stringify(ranked);

  const r1 = attributionSummary(ranked);

  // Snapshot after first call — must be byte-identical to before.
  const snapshotAfter = JSON.stringify(ranked);
  assert.equal(snapshotAfter, snapshotBefore,
    'attributionSummary must not mutate the input RankedAttribution');

  // Second call must return a deeply-equal result (deterministic, no clock/RNG).
  const r2 = attributionSummary(ranked);
  assert.deepEqual(r1, r2, 'two successive calls must return deeply-equal results');
  assert.equal(JSON.stringify(r1), JSON.stringify(r2),
    'JSON serialization of both calls must be byte-identical (replay-clean)');

  // Prove determinism further: top_posterior is the same float both times.
  assert.equal(r1.top_posterior, r2.top_posterior,
    'top_posterior must be identical across calls (no clock or RNG)');
  assert.equal(r1.headline, r2.headline,
    'headline must be byte-identical across calls');

  // The ranked array itself must be unmutated (spot-check ranked[0]).
  assert.equal(ranked.ranked[0].candidate.cause_id, 'deploy:t4-main',
    'ranked[0].candidate.cause_id must be unchanged after attributionSummary');
  assert.equal(ranked.ranked[0].posterior, r1.top_posterior,
    'ranked[0].posterior must equal top_posterior (no renormalization)');
});

// ── T5: CLI opt-in flag + default-unchanged + --check intact / AC-5 ─────────

test('T5 / AC-5 — CLI: --summary adds headline; default output unchanged; --check unaffected', () => {
  const ROOT       = path.resolve(__dirname, '..');
  const CLI        = path.join(ROOT, 'tools', 'cairn.js');
  const INCIDENT   = path.join(ROOT, 'demos', 'cairn-incident.json');
  const CANDIDATES = path.join(ROOT, 'demos', 'cairn-candidates.json');
  const WALKTHROUGH = path.join(ROOT, 'demos', 'cairn-attribution-walkthrough.json');

  // T5(a): ASCII mode with --summary contains the canonical headline.
  const asciiOut = execSync(
    `node ${CLI} ${INCIDENT} ${CANDIDATES} --summary`,
    { encoding: 'utf8' },
  );
  const expectedHeadline =
    'Top: deploy:model-weights-v2026-05-19-001 at 80.7% (3 ranked, 1 suppressed)';
  assert.ok(
    asciiOut.includes(expectedHeadline),
    `--summary ASCII output must contain headline "${expectedHeadline}"; got:\n${asciiOut}`,
  );

  // T5(b): JSON mode with --summary adds a top-level 'summary' key.
  const jsonSummaryOut = execSync(
    `node ${CLI} ${INCIDENT} ${CANDIDATES} --json --summary`,
    { encoding: 'utf8' },
  );
  const parsedSummary = JSON.parse(jsonSummaryOut);
  assert.ok('summary' in parsedSummary,
    '--json --summary must add a top-level summary key');
  const s = parsedSummary.summary;
  assert.equal(typeof s.headline,         'string');
  assert.equal(typeof s.top_cause_id,     'string');
  assert.equal(typeof s.top_posterior,    'number');
  assert.equal(typeof s.ranked_count,     'number');
  assert.equal(typeof s.suppressed_count, 'number');
  assert.equal(s.headline, expectedHeadline,
    'JSON summary.headline must match the canonical AC-2 exemplar');
  // All five fields must match the unit-test values.
  assert.equal(s.top_cause_id, 'deploy:model-weights-v2026-05-19-001');
  assert.equal(s.ranked_count, 3);
  assert.equal(s.suppressed_count, 1);

  // T5(c): Default output (no --summary) must NOT include a summary key and
  //         must still carry required v1 keys (byte-identical default invariant).
  const defaultOut = execSync(
    `node ${CLI} ${INCIDENT} ${CANDIDATES} --json`,
    { encoding: 'utf8' },
  );
  const defaultReport = JSON.parse(defaultOut);
  assert.equal('summary' in defaultReport, false,
    'default --json output must NOT include a summary key (pre-Q35 byte-identical)');
  assert.equal(defaultReport.cairn_report_version, 'v1',
    'default output must still carry cairn_report_version v1');
  assert.ok(Array.isArray(defaultReport.ranked),
    'default output must still carry ranked array');
  assert.ok(Array.isArray(defaultReport.suppressed),
    'default output must still carry suppressed array');

  // T5(d): --check replay fixture must still pass even when --summary is present.
  //         (--summary is ignored under --check; the early-return takes precedence.)
  // execSync throws if the process exits non-zero → test fails on mismatch.
  execSync(
    `node ${CLI} ${INCIDENT} ${CANDIDATES} --check ${WALKTHROUGH} --summary`,
    { encoding: 'utf8' },
  );
});

// ── T6: Honest-failure demo case / AC-2, AC-5 (no-self-confirming-demo) ──────

test('T6 / AC-2,AC-5 — prior-driven mis-attribution: headline confidently names the wrong top', () => {
  // This is the HONEST-FAILURE case required by [no-self-confirming-demo].
  //
  // The prior-sensitivity fixture (cairn-prior-sensitivity-demo.json) is the
  // known prior-driven mis-attribution from Q34: the deploy ranks #1 because
  // of its high kind prior (0.35), but under uniform priors the feature-flag
  // rollout — which is much better aligned (200s lag vs 1200s) — would take #1.
  //
  // attributionSummary faithfully prints a confident headline for this case
  // even though the ranking is wrong. The function has no notion of correctness.
  // This test documents that limitation: pairing with --prior-sensitivity is
  // necessary before trusting the headline in a postmortem.

  const ROOT       = path.resolve(__dirname, '..');
  const CLI        = path.join(ROOT, 'tools', 'cairn.js');
  const INCIDENT   = path.join(ROOT, 'demos', 'cairn-incident.json');
  const PRIOR_SENS_CANDIDATES =
    path.join(ROOT, 'demos', 'cairn-prior-sensitivity-demo.json');

  const jsonOut = execSync(
    `node ${CLI} ${INCIDENT} ${PRIOR_SENS_CANDIDATES} --json --summary`,
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(jsonOut);
  assert.ok('summary' in parsed, '--json --summary must add summary key');

  const s = parsed.summary;

  // The headline confidently names the deploy as top cause.
  // (This IS the prior-driven mis-attribution: feature-flag is better-timed
  //  but loses to the deploy's higher kind prior.)
  assert.equal(s.top_cause_id, 'deploy:checkout-svc-v2026-05-19-007',
    'prior-sens fixture: top_cause_id must be the deploy (prior-driven, not timing-optimal)');

  // Posterior rounds to 73.7% (computed: deploy raw_score / total).
  const pct = (s.top_posterior * 100).toFixed(1);
  assert.equal(pct, '73.7',
    `prior-sens fixture: posterior must round to 73.7%; got ${pct}`);

  // 2 ranked (deploy + feature-flag), 0 suppressed.
  assert.equal(s.ranked_count, 2,
    'prior-sens fixture: must have 2 ranked candidates');
  assert.equal(s.suppressed_count, 0,
    'prior-sens fixture: must have 0 suppressed candidates');

  // Headline exactly matches the spec's honest-failure exemplar.
  const expectedHeadline =
    'Top: deploy:checkout-svc-v2026-05-19-007 at 73.7% (2 ranked, 0 suppressed)';
  assert.equal(s.headline, expectedHeadline,
    `prior-sens headline must match known mis-attribution exemplar; got: "${s.headline}"`);

  // Verify the headline would FAIL for the correct (better-timed) candidate:
  // if attributionSummary.top_cause_id were the feature-flag, this assertion
  // would catch it. The deploy ranking is the wrong answer — the summary
  // is faithfully reporting the scorer's (prior-biased) output.
  assert.notEqual(s.top_cause_id, 'external:feature-flag-rollout-2026-05-19',
    'prior-sens: top must NOT be the feature-flag (it is the known better-aligned candidate, but loses to deploy prior)');
});
