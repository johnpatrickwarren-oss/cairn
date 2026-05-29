# Q34 — Cairn prior-sensitivity diagnostic spec

_From: Architect. To: Implementer (Anchor `anchor run --tier full`, R02)._
_Date: 2026-05-29._
_Foundation: [PRD-30-cairn.md](PRD-30-cairn.md) + [Q30-CAIRN-ATTRIBUTION-SPEC.md](Q30-CAIRN-ATTRIBUTION-SPEC.md) (shipped Cairn v1)._
_Type: full implementation brief (inline ceremony)._
_Pinned SHA: `6a529cb805e71d3c0d67822bfffcb9d690dd7e81` (HEAD; `chore: initial extraction from deploysignal#21 (Cairn v1)`)._
_Framework: Anchor methodology (Architect role; T0 anchor; skills 01 pre-emit-grilling, 06 anti-scope-ledger, 08 six-practices)._

---

## Spec

Cairn's per-candidate raw score is `s(c) = K(Δt, σ_kind) × π(kind) × e(c)` — a timing kernel, a per-kind **prior** `π(kind)`, and an evidence-quality boost. The posterior is `s(c) / Σ s(c')`. An operator looking at a ranked report cannot tell, from the report alone, whether the **#1 candidate** won because its **timing evidence** is strong or merely because the operator's **prior** favored that cause-kind. A ranking that flips the instant priors are flattened is *prior-driven* and should be trusted less.

Add a **prior-sensitivity diagnostic**: a pure, read-only function that re-ranks the *same* candidates against the *same* incident under **uniform priors** (every cause-kind given an equal `kind_prior`) and reports whether the top candidate changes.

This is a **measurement layer over the scorer**, not a scoring change. It calls the existing `rankCandidates` twice — once with the caller's config (baseline), once with a freshly-built uniform-prior config — and compares the two top candidates. It adds zero new math, no new detector, no change to `score.ts` / `rankCandidates` / `scoreCandidate` output shape, and no change to the default CLI output. New capability is surfaced behind an opt-in `tools/cairn.js --prior-sensitivity` flag.

Closes Q34 AC-1 through AC-6.

---

## Architectural mechanism

One new pure function, composed entirely out of the existing scorer:

1. **Baseline rank.** `rankCandidates(candidates, incident, config)` → `RankedAttribution`. `baseline_top` is `ranked[0]` (or `null` if `ranked` is empty).

2. **Uniform-prior rank.** Build a *fresh* config object `uniformConfig = { ...config, kind_prior: <flattened> }` — preserving the caller's `kernel_sigma_seconds`, `grace_seconds`, and `evidence_boost` verbatim, and replacing only `kind_prior`. Call `rankCandidates(candidates, incident, uniformConfig)` → `uniform_top = ranked[0]` (or `null`).

3. **Compare.** `prior_driven := baseline_top_cause_id !== uniform_top_cause_id` (string/`null` identity comparison — never a float comparison). Report both tops' `cause_id` and their respective `posterior`.

### How "uniform priors" is built (load-bearing design decision)

"Uniform priors" means every cause-kind that participates in the ranking gets the **same** `kind_prior` value. The implementer builds the flattened `kind_prior` by mapping **every cause-kind actually present in `candidates`** to a single shared constant:

```ts
const UNIFORM_PRIOR = 1; // value is immaterial (see proof below); 1 chosen for clarity
const flat: Partial<Record<CandidateKind, number>> = {};
for (const c of candidates) flat[c.cause_kind] = UNIFORM_PRIOR;
const uniformConfig = { ...config, kind_prior: flat };
```

**Why flatten only the present kinds, not a hardcoded `ALL_KINDS` list:** `effectiveConfig` (score.ts:43–59) merges the supplied `kind_prior` *over* `DEFAULT_KIND_PRIOR`. Kinds absent from the candidate set keep their default prior in `config_used`, but their prior is **never read** during scoring (no candidate of that kind exists), so it cannot affect the ranking. Flattening exactly the present kinds is therefore equivalent to flattening all six kinds, and it is **drift-proof**: if a 7th `CandidateKind` is added later, this code needs no edit. (A hardcoded `ALL_KINDS` array is the alternative; it is rejected because it silently rots when the kind union grows.)

**Why the constant value is immaterial (proof obligation — must hold for any positive constant):** with a uniform prior `p` for every present kind, `s(c) = K(c) × p × e(c)`, so the posterior is `K(c)·p·e(c) / Σ K(c')·p·e(c') = K(c)·e(c) / Σ K(c')·e(c')` — the `p` cancels. The *ranking and `prior_driven` verdict are independent of the chosen constant*; only the absolute posterior magnitudes are unaffected too (they normalize). A test asserts that two different positive constants produce the same `prior_driven`/ordering (AC-5). `1` is chosen over `1/6` purely for readability.

### Suppression is invariant under prior flattening (anticipated reviewer probe)

Both suppression reasons (`post_incident_timestamp`, `kernel_underflow` — score.ts:118–135) depend only on `Δt`, the grace window, and the kernel value — **never on the prior**. Therefore the `suppressed[]` set is byte-identical between the baseline and uniform ranks; only the *ordering and posteriors of the survivors* can change. The diagnostic compares only `ranked[0]`, which is correct.

### Empty / all-suppressed handling (AC-4)

If `candidates` is empty — or every candidate is suppressed — `ranked` is `[]` in **both** ranks. Then `baseline_top` and `uniform_top` are both `null`, `prior_driven` is `null !== null` → `false`, and both posteriors are `0`. No throw. These two paths (empty input, all-suppressed) collapse to the same code path via `ranked[0] ?? null`.

---

## Existing architectural surface (REVIEWER-ANCHOR — mandatory)

All snippets verbatim from pinned SHA `6a529cb805e71d3c0d67822bfffcb9d690dd7e81`, opened 2026-05-29 via this session's Read tool calls.

| Inherited file | Pinned SHA | Lines | Verbatim snippet | Why cited |
|---|---|---|---|---|
| `score.ts` | `6a529cb` | 142–146 | `export function rankCandidates(\n  candidates: AttributionCandidate[],\n  incident: IncidentDefinition,\n  config: CairnScoringConfig = {},\n): RankedAttribution {` | The only scorer entry point the diagnostic calls. Called twice (baseline + uniform). Returns the `RankedAttribution` whose `ranked[0]` is the "top". |
| `score.ts` | `6a529cb` | 167–173 | `const total = scored.reduce((acc, s) => acc + s.raw_score, 0);\n  for (const s of scored) s.posterior = total > 0 ? s.raw_score / total : 0;\n\n  scored.sort((a, b) => {\n    if (b.posterior !== a.posterior) return b.posterior - a.posterior;\n    return a.candidate.timestamp_unix - b.candidate.timestamp_unix;` | Posterior normalization (`p` cancels under uniform prior — see proof) + the deterministic `(posterior desc, timestamp asc)` tiebreak that makes `ranked[0]` well-defined and replay-clean. |
| `score.ts` | `6a529cb` | 19–26 | `const DEFAULT_KIND_PRIOR: Record<CandidateKind, number> = {\n  deploy: 0.35,\n  chaos_experiment: 0.20,\n  dependency_change: 0.15,\n  env_change: 0.10,\n  shard_event: 0.10,\n  generic: 0.10,\n};` | The non-uniform default prior the diagnostic flattens. Note `deploy` (0.35) dominates — the demo's prior-driven flip is built around it. |
| `score.ts` | `6a529cb` | 43–59 | `function effectiveConfig(config: CairnScoringConfig): RankedAttribution['config_used'] {\n  return {\n    ...\n    kind_prior: {\n      ...DEFAULT_KIND_PRIOR,\n      ...(config.kind_prior ?? {}),\n    } as Record<CandidateKind, number>,` | Confirms supplied `kind_prior` is **merged over** defaults (justifies "flatten present kinds only") and that `effectiveConfig` builds fresh objects — i.e. `rankCandidates` does not mutate the caller's `config`. |
| `score.ts` | `6a529cb` | 118–135 | `if (delta < -cfg.grace_seconds) {\n    return {\n      ... suppressed: { candidate, suppression_reason: 'post_incident_timestamp' },\n    };\n  }\n  ... const suppressed: SuppressedCandidate | null =\n      kernel_value < KERNEL_UNDERFLOW\n        ? { candidate, suppression_reason: 'kernel_underflow' }` | Both suppression reasons are prior-independent → `suppressed[]` is identical across baseline/uniform ranks. |
| `types.ts` | `6a529cb` | 61–72 | `export interface CairnScoringConfig {\n  kernel_sigma_seconds?: Partial<Record<CandidateKind, number>>;\n  kind_prior?: Partial<Record<CandidateKind, number>>;\n  grace_seconds?: number;\n  evidence_boost?: Partial<Record<'proceed' | 'extend' | 'rollback' | 'baking', number>>;\n}` | The config shape the diagnostic shallow-copies + overrides `kind_prior` on. Only `kind_prior` is replaced; the other three keys pass through. |
| `types.ts` | `6a529cb` | 74–84 | `export interface ScoredCandidate {\n  candidate: AttributionCandidate;\n  posterior: number;\n  raw_score: number;\n  kernel_value: number;\n  kind_prior: number;\n  evidence_boost: number;\n}` | `ranked[0]` is a `ScoredCandidate`; the diagnostic reads `.candidate.cause_id` and `.posterior` from it. |
| `types.ts` | `6a529cb` | 93–108 | `export interface RankedAttribution {\n  ranked: ScoredCandidate[];\n  suppressed: SuppressedCandidate[];\n  incident: IncidentDefinition;\n  config_used: { ... };\n}` | Return type of `rankCandidates`; `.ranked` is the array indexed at `[0]`. |
| `index.ts` | `6a529cb` | 9–11 | `export { scoreCandidate, rankCandidates } from './score';\nexport type { ScoreBreakdown } from './score';` | Barrel pattern to mirror: add `priorSensitivity` + `PriorSensitivity` exports here so `require('../dist')` in the CLI resolves them. |
| `tools/cairn.js` | `6a529cb` | 122–155 | `function main() {\n  const args = process.argv.slice(2);\n  ...\n  const jsonOut = args.includes('--json');\n  const checkIdx = args.indexOf('--check');\n  ... if (checkPath) { ... return; }\n  if (jsonOut) { process.stdout.write(...) } else { console.log(renderAscii(report)); }` | The flag-parsing + output site to extend with `--prior-sensitivity`. The `--check` early-return must stay above/unaffected by the new flag (replay fixture protection). |
| `tools/cairn.js` | `6a529cb` | 61–72 | `function buildReport(incident, candidatesSrc) {\n  const candidates = assembleCandidates(candidatesSrc);\n  const config = candidatesSrc.config ?? {};\n  const ranked = rankCandidates(candidates, incident, config);\n  return { cairn_report_version: REPORT_VERSION, ... };` | The CLI already assembles `candidates` + `config`; the diagnostic reuses these exact two values. The base `report` object stays byte-identical. |
| `tsconfig.json` | `6a529cb` | 19 | `"include": ["index.ts", "score.ts", "ingest.ts", "types.ts"],` | Must gain `"prior-sensitivity.ts"` so `tsc` compiles it into `dist/`. |
| `test/q30-cairn-cli.test.ts` | `6a529cb` | 43–53 | `test('Q30 / AC-6 — --check mode passes against saved walkthrough JSON (replay-clean)', () => { ... execSync(\`node ${CLI} ${INCIDENT} ${CANDIDATES} --check ${WALKTHROUGH}\`...) })` | The replay-clean `--check` invariant the new flag must not disturb. New CLI test for `--prior-sensitivity` lives alongside but in the Q34 test file. |

**Architect self-attest checklist (ticked at emit):**

- [x] Files opened at brief-drafting time via this session's Read/Grep calls.
- [x] Snippet citations verbatim from pinned SHA `6a529cb805e71d3c0d67822bfffcb9d690dd7e81` (current HEAD).
- [x] Line numbers verified against file content at the pinned SHA.
- [x] Verified `rankCandidates` / `effectiveConfig` build fresh objects and write `posterior` only onto new `ScoredCandidate`s — they do **not** mutate caller `config` or `candidates`. The diagnostic's read-only obligation reduces to "don't mutate inputs in the diagnostic itself."

---

## Implementation surface

### File: `prior-sensitivity.ts` (new — repo root, sibling to `score.ts`)

Extensionless TS imports per repo convention. Pure; no `Math.random`, no `Date.now`, no `new Date()`, no I/O.

```ts
// prior-sensitivity.ts — Cairn prior-sensitivity diagnostic (Q34 / Addition #34).
//
// READ-ONLY measurement over the scorer. Re-ranks the same candidates under
// uniform priors and reports whether the #1 candidate flips. Calls the
// existing rankCandidates twice; adds no new scoring math, mutates nothing.

import type {
  AttributionCandidate, CandidateKind, IncidentDefinition, CairnScoringConfig,
} from './types';
import { rankCandidates } from './score';

/** Result of the prior-sensitivity diagnostic. Field shape is frozen by
 *  Q34 AC-2; do not add/rename fields without a follow-on AC. */
export interface PriorSensitivity {
  /** cause_id of the #1 candidate under the caller's (baseline) priors,
   *  or null when no candidate is ranked. */
  baseline_top_cause_id: string | null;
  /** cause_id of the #1 candidate under flattened (uniform) priors,
   *  or null when no candidate is ranked. */
  uniform_top_cause_id: string | null;
  /** True iff flattening priors changes the #1 candidate. A true value
   *  means the baseline top is winning (at least partly) on its prior,
   *  not on timing/evidence alone — trust it less. */
  prior_driven: boolean;
  /** Posterior of the baseline #1 candidate (0 when none ranked). */
  baseline_top_posterior: number;
  /** Posterior of the uniform #1 candidate (0 when none ranked). */
  uniform_top_posterior: number;
}

/** Uniform-prior constant. Value is immaterial to the verdict: under a
 *  uniform prior p, p cancels in the posterior normalization, so the
 *  ranking is independent of the constant chosen. 1 picked for clarity. */
const UNIFORM_PRIOR = 1;

/** Build a FRESH config that flattens kind_prior to uniform across every
 *  cause-kind present in `candidates`, preserving all other config keys.
 *  Does not mutate `config`. */
function uniformPriorConfig(
  candidates: AttributionCandidate[],
  config: CairnScoringConfig,
): CairnScoringConfig {
  const flat: Partial<Record<CandidateKind, number>> = {};
  for (const c of candidates) flat[c.cause_kind] = UNIFORM_PRIOR;
  return { ...config, kind_prior: flat };
}

/** Prior-sensitivity diagnostic. Pure + deterministic. Read-only over the
 *  scorer — does not mutate `candidates` or `config`. */
export function priorSensitivity(
  candidates: AttributionCandidate[],
  incident: IncidentDefinition,
  config: CairnScoringConfig = {},
): PriorSensitivity {
  const baseline = rankCandidates(candidates, incident, config);
  const uniform = rankCandidates(candidates, incident, uniformPriorConfig(candidates, config));

  const baselineTop = baseline.ranked[0] ?? null;
  const uniformTop = uniform.ranked[0] ?? null;

  const baseline_top_cause_id = baselineTop ? baselineTop.candidate.cause_id : null;
  const uniform_top_cause_id = uniformTop ? uniformTop.candidate.cause_id : null;

  return {
    baseline_top_cause_id,
    uniform_top_cause_id,
    prior_driven: baseline_top_cause_id !== uniform_top_cause_id,
    baseline_top_posterior: baselineTop ? baselineTop.posterior : 0,
    uniform_top_posterior: uniformTop ? uniformTop.posterior : 0,
  };
}
```

### File: `index.ts` (edit — additive, mirror existing barrel pattern)

Append after the existing `score` exports (index.ts:9–11):

```ts
export { priorSensitivity } from './prior-sensitivity';
export type { PriorSensitivity } from './prior-sensitivity';
```

### File: `tsconfig.json` (edit — additive)

Add `"prior-sensitivity.ts"` to the `include` array (tsconfig.json:19):

```json
"include": ["index.ts", "score.ts", "ingest.ts", "types.ts", "prior-sensitivity.ts"],
```

### File: `tools/cairn.js` (edit — strictly additive, opt-in flag only)

**Default output must stay byte-identical.** Rules:

1. Parse `const priorSens = args.includes('--prior-sensitivity');` next to the existing `jsonOut` parse (cairn.js:130).
2. The `--check` branch (cairn.js:138–148) returns early and is **left exactly as-is** — `--prior-sensitivity` is ignored under `--check` so the replay fixture path is untouched.
3. When `priorSens` is **false**, both the `--json` and ASCII paths emit exactly the bytes they emit today. No new keys, no new lines. (Tested.)
4. When `priorSens` is **true**:
   - `--json`: add a single top-level key `prior_sensitivity` to the emitted envelope (the base `report` object from `buildReport` is unchanged; the key is added only on the way out, only under the flag).
   - ASCII: after `renderAscii(report)`, print a separate diagnostic block (see below). The base report ASCII is unchanged.
5. The diagnostic value comes from `priorSensitivity(candidates, incident, config)` — reuse the same `candidates`/`config` `buildReport` assembles. Refactor `main` minimally so `candidates` + `config` are available at the output site (e.g. have `buildReport` also return them, or recompute via the existing `assembleCandidates`). **Do not** change what `buildReport`'s `report` object contains.
6. The diagnostic ASCII block must use only input-derived values — no `Date.now`, no `Math.random` (NFR-3). (Numeric fields only; no timestamps needed in this block.)

Suggested ASCII block (illustrative; exact wording is implementer's, but must include the verdict + both tops + both posteriors):

```
  Prior-sensitivity diagnostic:
  ────────────────────────────────────────────────────────────────────────
    baseline #1: <baseline_top_cause_id>   (posterior <baseline_top_posterior>)
    uniform  #1: <uniform_top_cause_id>    (posterior <uniform_top_posterior>)
    prior_driven: <true|false>
    <if true>  ⚠ top candidate's lead depends on the prior, not timing alone.
    <if false> ✓ top candidate is robust to flattening the prior.
```

### File: `demos/cairn-prior-sensitivity-demo.json` (new — fixture with a genuine prior-driven flip)

A candidates source (same shape `tools/cairn.js` already accepts) that, against the existing `demos/cairn-incident.json` (`onset_time_unix: 1747700400`), produces a **prior-driven flip** — the demo's required "case the system gets wrong" (a #1 that wins on prior, not evidence):

```json
{
  "ds_records": [
    {
      "deploy_id": "checkout-svc-v2026-05-19-007",
      "ts": 1747699200,
      "config_version": "v2026-05-19-checkout"
    }
  ],
  "external_events": [
    {
      "event_id": "feature-flag-rollout-2026-05-19",
      "timestamp_unix": 1747700200,
      "event_kind": "generic",
      "description": "Gradual feature-flag rollout reached 100% fleet",
      "source": "flag-service"
    }
  ]
}
```

Worked numbers (`onset = 1747700400`, deploy σ=1800s, generic σ=3600s, evidence boost 1.0 for both):

- **deploy**: Δt = 1200s → `K = exp(-0.5·(1200/1800)²) ≈ 0.8007`.
  - baseline raw = `0.8007 × 0.35 = 0.2802`; uniform raw = `0.8007 × 1 = 0.8007`.
- **generic** (flag rollout): Δt = 200s → `K = exp(-0.5·(200/3600)²) ≈ 0.99846`.
  - baseline raw = `0.99846 × 0.10 = 0.0998`; uniform raw = `0.99846 × 1 = 0.99846`.

→ **Baseline:** deploy #1 (0.2802 vs 0.0998) — the deploy's 0.35 prior carries it.
→ **Uniform:** generic #1 (0.99846 vs 0.8007) — the better-timed flag rollout wins once the prior is removed.
→ `prior_driven === true`. Comfortable margins (no knife-edge / FP sensitivity).

**Operator reading:** the report blames the deploy, but the deploy is winning on its prior, not on timing — the flag rollout is actually the better-aligned candidate. That is exactly the false-attribute Cairn's negative-evidence boost (Q30.3) guards against, surfaced here as a *diagnostic* rather than a scoring change.

### File: `demos/CAIRN-DEMO.md` (edit — additive append)

Append a "Prior-sensitivity diagnostic (Q34)" section: the command (`node tools/cairn.js demos/cairn-incident.json demos/cairn-prior-sensitivity-demo.json --prior-sensitivity --json`), the expected `prior_driven: true` verdict, and the worked numbers above. **Also** state the contrasting robust case: the original `demos/cairn-candidates.json` scenario, where the deploy is so dominant it stays #1 even under uniform priors (`prior_driven: false`) — so the demo shows **both** a flip and a non-flip and is not self-confirming.

---

## Tests

### `test/q34-cairn-prior-sensitivity.test.ts` (new — ≥ 6 tests, each mapped to an AC)

Build against `dist/` (`import { priorSensitivity } from '../dist/prior-sensitivity'`, types from `'../dist/types'`), `node --test`, mirroring `test/q30-cairn-score.test.ts`. Use a fixed `T0` constant (no clock).

1. **AC-1 / AC-2 — module + shape.** `priorSensitivity` is a function; on a non-empty input it returns an object with exactly the five keys, with correct types (`baseline_top_cause_id`/`uniform_top_cause_id` are `string | null`, `prior_driven` boolean, two `number` posteriors).
2. **AC-3 — prior-driven flip detected.** The demo scenario (deploy ts=onset−1200 + generic ts=onset−200). Assert `baseline_top_cause_id` is the deploy, `uniform_top_cause_id` is the generic, and `prior_driven === true`. Additionally assert the invariant literally: `prior_driven === (baseline_top_cause_id !== uniform_top_cause_id)`.
3. **AC-3 — robust (non-flip) case.** A scenario where the timing-dominant candidate also has the favored prior (e.g. a single deploy near onset, or a deploy that dominates on kernel too). Assert `prior_driven === false` and both tops equal. Proves the diagnostic does not cry wolf.
4. **AC-4 — empty candidate set.** `priorSensitivity([], incident)` does **not** throw; returns `baseline_top_cause_id === null`, `uniform_top_cause_id === null`, `prior_driven === false`, both posteriors `=== 0`. (Add a sibling assertion for the all-suppressed case: every candidate post-incident → same nulls/false/0.)
5. **AC-5 — read-only / no mutation.** Deep-clone (`structuredClone` or JSON round-trip) the `candidates` array and the `config` object before the call; after the call, `assert.deepEqual` the originals against their pre-call snapshots — neither is mutated. Also assert `config.kind_prior` is still the caller's (or still `undefined`).
6. **AC-5 — purity / determinism + constant-immateriality.** Two successive calls with identical inputs produce `deepEqual` results (no RNG/clock). And: passing a config whose `kind_prior` is *already* uniform yields `prior_driven === false` with `baseline_top === uniform_top` (flattening an already-flat prior is a no-op) — demonstrating the verdict depends on prior *shape*, not the constant.
7. **AC-6 (CLI) — opt-in flag.**
   - With `--prior-sensitivity --json`: parsed JSON has a top-level `prior_sensitivity` object with `prior_driven === true` for the demo fixture.
   - **Default-output-unchanged guard:** capture `node tools/cairn.js <incident> <candidates> --json` (no flag) and assert it is byte-identical to today's output / lacks any `prior_sensitivity` key. (This is the byte-identical-default invariant.)
   - `--check` still passes with `--prior-sensitivity` present on the same line (flag ignored under `--check`).

> Note: tests 2 and 3 are the demo's flip + non-flip pair, satisfying the "demo must include a case the system gets wrong" reinforcement (the flip case *is* the wrong-attribution the baseline ranking commits).

---

## Acceptance criteria (Q34)

| AC | Statement | Covered by |
|---|---|---|
| AC-1 | `prior-sensitivity.ts` exports `priorSensitivity(candidates, incident, config?) => PriorSensitivity`. | Test 1; index.ts + tsconfig edits |
| AC-2 | `PriorSensitivity` = the five fields with stated types. | `PriorSensitivity` interface; Test 1 |
| AC-3 | Uniform priors = equal `kind_prior` for all kinds; `prior_driven === (baseline_top_cause_id !== uniform_top_cause_id)`. | `uniformPriorConfig`; Tests 2, 3 |
| AC-4 | Empty set → both tops `null`, `prior_driven false`, posteriors `0`, no throw. | `?? null` guard; Test 4 |
| AC-5 | Pure + deterministic; strictly additive (no `score.ts`/`rankCandidates`/default-CLI change); read-only (no mutation of `config`/`candidates`; fresh uniform config). | Whole design; Tests 5, 6 |
| AC-6 | ≥ 6 tests in `test/q34-cairn-prior-sensitivity.test.ts` each mapping to an AC; opt-in `tools/cairn.js --prior-sensitivity` (default output unchanged); demo includes a genuine prior-driven flip. | Tests 1–7; CLI flag; `cairn-prior-sensitivity-demo.json` |

---

## Anti-scope

Per [`skills/06-anti-scope-ledger.md`] and the PRD-30 anti-scope ledger. **NOT in scope for Q34:**

- **NO change to the scorer's math or output shape.** `score.ts`, `scoreCandidate`, `rankCandidates`, `ScoreBreakdown`, `ScoredCandidate`, `RankedAttribution` are read, never edited. The diagnostic adds zero terms to `s(c) = K × π × e`.
- **NO change to the default CLI output.** `--prior-sensitivity` is strictly opt-in; without it, `tools/cairn.js` emits byte-identical bytes (tested). The `--check` replay fixture path is untouched and takes precedence.
- **NO causal-inference framing** (PRD-30 AS-3). This is *alignment-prior sensitivity*, not counterfactual reasoning. The verdict word is `prior_driven`, never "root cause" / "causal."
- **NO new detector family / no `engine/detectors/*` touch** (Q2.B.6.4 ADR). Pure scoring-adjacent measurement layer.
- **NO live telemetry / no new ingestion adapters** (PRD-30 AS-1, NFR-5). Reuses existing fixtures + ingest helpers only.
- **NO mutation of scorer config or output as a side effect** (read-only diagnostic discipline). Uniform re-rank uses a freshly-built config object; caller's `config`/`candidates` are never written.
- **NO new `CandidateKind`, no new `CairnScoringConfig` field, no schema bump.** The flattened prior is an *internal, transient* config, not a persisted shape.
- **NO multi-incident batch, no web UI, no streaming** (PRD-30 AS-4/AS-6/AS-7). One incident, one diagnostic, CLI + library surface.
- **NO sensitivity analysis beyond the top candidate** (e.g. full rank-correlation / Kendall-τ across the whole list, per-kind elasticity). v1 reports only whether `ranked[0]` flips. Whole-ranking drift metrics are a candidate follow-on, explicitly deferred.
- **NO change to `tessera`/`anvil`/DS wire contracts.**

**Cross-references preserved:** Q2.B.6.4 ADR clauses 1–5; Q30 ADR (consumes Q30 scorer unchanged); Q60 V2 clause 3 (no live customer telemetry); enterprise-infrastructure boundary; no-skip policy.

---

## Pre-emit grilling pass (skill 01)

### CRITICAL (would fail an AC or break an invariant if wrong)

- **C1 — Caller config/candidates must not mutate (AC-5, read-only).** `rankCandidates`→`effectiveConfig` (score.ts:43–59) build fresh objects via spread and write `posterior` only onto new `ScoredCandidate`s (score.ts:157–168), so the scorer is non-mutating. The diagnostic's only obligation is to build the uniform config as `{ ...config, kind_prior: <fresh object> }` and **never** assign into `config.kind_prior` or any candidate. **Resolution:** `uniformPriorConfig` returns a new object; Test 5 deep-equals inputs against pre-call snapshots.
- **C2 — Default CLI output must stay byte-identical (AC-5/AC-6, replay-clean).** Adding a `prior_sensitivity` key unconditionally, or printing the ASCII block unconditionally, would break the `--check` walkthrough fixture and every downstream byte-compare. **Resolution:** flag-gated emission; `--check` early-return left verbatim and takes precedence; Test 7 asserts no-flag output is unchanged and lacks the key.
- **C3 — Empty / all-suppressed must not throw (AC-4).** `ranked[0]` on `[]` is `undefined`; an unguarded `.candidate.cause_id` would throw. **Resolution:** `baseline.ranked[0] ?? null` and ternary guards; both tops `null`, `prior_driven false`, posteriors `0`. Test 4 covers empty *and* all-suppressed.
- **C4 — `prior_driven` must equal the AC-3 identity exactly.** Defined as `baseline_top_cause_id !== uniform_top_cause_id` over `string | null` — never a float comparison (no `<`/epsilon), so no FP flakiness. Test 2 asserts the literal identity.

### LIKELY-SURFACES (a reviewer will probe these)

- **L1 — "Does the uniform constant value change the verdict?"** No — proof in §Architectural mechanism (the `p` cancels in posterior normalization). Test 6 asserts an already-uniform input yields no flip; the constant `1` is documented as arbitrary-but-immaterial.
- **L2 — "Why flatten only present kinds, not all six?"** Because `effectiveConfig` merges over `DEFAULT_KIND_PRIOR` and absent kinds' priors are never read during scoring; flattening present kinds is equivalent and drift-proof. Documented + justified with the score.ts:43–59 citation.
- **L3 — "Could suppression differ between baseline and uniform, making the comparison apples-to-oranges?"** No — both suppression reasons are prior-independent (score.ts:118–135); `suppressed[]` is identical across the two ranks. Documented.
- **L4 — "A flip caused purely by the deterministic timestamp tiebreak when posteriors tie."** Possible in principle (e.g. two candidates that tie under uniform but not baseline). This is still a legitimate flip — the top *did* change — so reporting `prior_driven: true` is correct. The demo uses comfortable margins so it is not a tiebreak artifact. Documented as accepted behavior.
- **L5 — "Are the two reported posteriors comparable?"** They are the posteriors of two *different* rankings' tops and are not meant to be subtracted; AC-2 defines each independently. The ASCII/JSON labels them `baseline #1` / `uniform #1` to avoid the misread. Documented.

### PRE-EMPTABLE (head off before review)

- **P1 — Tempting shortcut: add a `flattenPriors` option to `rankCandidates`.** Rejected — violates "do not modify `score.ts`/`rankCandidates`" (AC-5). The diagnostic composes the existing function twice instead.
- **P2 — Self-confirming demo.** Forbidden by reinforcement. The demo ships **both** a prior-driven flip (`cairn-prior-sensitivity-demo.json`) and a robust non-flip (the existing `cairn-candidates.json` deploy-dominant case). The flip case is the "case the system gets wrong" — a #1 that wins on prior, not evidence.
- **P3 — Clock/RNG leak.** The function uses none. The CLI diagnostic block must avoid `new Date(...)` entirely (numeric fields only), even though the base report's `renderAscii` uses `new Date(ts*1000).toISOString()` (deterministic from input, not `Date.now()` — still replay-clean). Documented in the CLI edit rules.
- **P4 — `cause_id` uniqueness assumption.** The verdict compares `cause_id` strings; ingest helpers construct unique `cause_id`s (`deploy:<id>`, `external:<id>`, etc.). If two candidates somehow shared a `cause_id`, a real flip could read as no-flip — but that is a malformed input outside Cairn's contract; noted, not handled at v1.
- **P5 — Build/registration drift.** Forgetting `tsconfig.json` `include` or the `index.ts` barrel export would leave the CLI's `require('../dist')` unable to resolve `priorSensitivity`. Both edits are called out explicitly in the implementation surface and are part of AC-1's coverage.

---

## Implementation timeline (Implementer)

- ~10 min: `prior-sensitivity.ts` (the function — trivial composition).
- ~5 min: `index.ts` barrel export + `tsconfig.json` include.
- ~20 min: `tools/cairn.js` `--prior-sensitivity` flag (additive, gated) + minimal `main` refactor to surface `candidates`/`config`.
- ~10 min: `demos/cairn-prior-sensitivity-demo.json` + `CAIRN-DEMO.md` append.
- ~30 min: `test/q34-cairn-prior-sensitivity.test.ts` (7 tests).
- ~5 min: full build + `node --test`; confirm pre-existing suite count unchanged + 7 new pass; confirm default CLI output byte-identical.

---

_Spec authored under Anchor methodology: Q-NN-SPEC-TEMPLATE + `08-architect-six-practices` + `03-four-anchor-defense` (T0 anchor) + `01-pre-emit-grilling` + `06-anti-scope-ledger`. Cross-references PRD-30 + Q30-CAIRN-ATTRIBUTION-SPEC for traceability. Read-only diagnostic; strictly additive; replay-clean._
