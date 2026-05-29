# Q33 — Cairn candidate-coverage diagnostic spec

_Anchor cycle R01 · tier full · role: architect_
_Repo pinned at SHA `6a529cb` (`6a529cb805e71d3c0d67822bfffcb9d690dd7e81`)._
_Brief: tool-run R01 — "Cairn candidate-coverage diagnostic". Closes the
silent-under-attribution blind spot surfaced by the Q32 calibration harness._

---

## Spec

Cairn's scorer (`score.ts`) suppresses any candidate whose Gaussian kernel
collapses below `KERNEL_UNDERFLOW` (1e-12) — e.g. a `chaos_experiment` 90 min
before onset against a 5-min σ kernel. That candidate lands in `suppressed[]`
with reason `kernel_underflow` and is **never ranked**. If the true cause is a
slow-burn event earlier than the operator's candidate lookback, the operator
gets a confident-looking ranking with **no signal that the window was too
narrow to contain it**. This is a silent under-attribution.

Add a **pure, read-only candidate-coverage diagnostic**: a function that
inspects the candidate set against the incident onset and the scorer's
configured per-kind kernel bandwidths, and warns when the lookback window looks
too narrow to trust the attribution. It does **not** change scoring, ranking,
or the default CLI output. It is a *measurement layer* over the scorer.

The diagnostic is exposed:
- as a new module `coverage.ts` exporting `coverageDiagnostic(...)`,
- re-exported from `index.ts`,
- behind an **opt-in** `tools/cairn.js --coverage` flag (default output
  byte-identical).

---

## Architectural mechanism

```
coverageDiagnostic(candidates, incident, config?)
  │
  ├─ candidate_count = candidates.length
  │
  ├─ if candidate_count === 0:
  │     → { 0, null, null, false, "no candidates supplied…" }   (no throw)
  │
  ├─ earliest_lead_seconds = incident.onset_time_unix − min(c.timestamp_unix)
  │
  ├─ σ-map  = rankCandidates([], incident, config).config_used.kernel_sigma_seconds
  │            ── read-only; resolves defaults⊕config WITHOUT duplicating the
  │               private DEFAULT_KERNEL_SIGMA_SECONDS constant (drift-proof)
  │
  ├─ widest_sigma_seconds = max( σ-map[k] for k in distinct cause_kinds present )
  │
  ├─ adequately_covered = earliest_lead_seconds >= 2 × widest_sigma_seconds
  │
  └─ warning = adequately_covered ? null : "<window-too-narrow message>"
```

**Why read the σ-map via `rankCandidates([], …).config_used`?** The default
bandwidths live in the un-exported `DEFAULT_KERNEL_SIGMA_SECONDS` constant
inside `score.ts` (lines 10–17). AC-5 forbids modifying `score.ts`, so we
cannot export it. The only public surface that exposes the *merged*
(defaults ⊕ operator config) σ map is `RankedAttribution.config_used.
kernel_sigma_seconds` (`score.ts:44–48`, `types.ts:102–107`). Calling
`rankCandidates([], incident, config)` is **pure, O(1)** (no candidates → no
scoring work; see `score.ts:148–180`) and returns the authoritative effective
config. This makes the diagnostic **drift-proof**: if a future change retunes a
default σ, the diagnostic tracks it automatically. The rejected alternative —
duplicating the σ constant in `coverage.ts` — would silently drift out of sync
the first time `score.ts` is retuned.

---

## Existing architectural surface (REVIEWER-ANCHOR — mandatory)

Every inherited primitive, pinned at SHA `6a529cb`.

| # | File | Lines | Primitive | Verbatim snippet |
|---|------|-------|-----------|------------------|
| S1 | `score.ts` | 10–17 | Default per-kind kernel σ (NOT exported — cannot be imported) | `const DEFAULT_KERNEL_SIGMA_SECONDS: Record<CandidateKind, number> = {`<br>`  deploy: 30 * 60,             //  30 minutes`<br>`  chaos_experiment: 5 * 60,    //   5 minutes`<br>`  dependency_change: 2 * 3600, //   2 hours`<br>`  env_change: 6 * 3600,        //   6 hours`<br>`  shard_event: 15 * 60,        //  15 minutes`<br>`  generic: 1 * 3600,           //   1 hour`<br>`};` |
| S2 | `score.ts` | 43–59 | `effectiveConfig` — merges defaults ⊕ config; produces `config_used` (also un-exported) | `function effectiveConfig(config: CairnScoringConfig): RankedAttribution['config_used'] {`<br>`  return {`<br>`    kernel_sigma_seconds: {`<br>`      ...DEFAULT_KERNEL_SIGMA_SECONDS,`<br>`      ...(config.kernel_sigma_seconds ?? {}),`<br>`    } as Record<CandidateKind, number>, …` |
| S3 | `score.ts` | 142–181 | `rankCandidates` — public; returns `config_used`; empty input → no scoring, returns echoed config | `export function rankCandidates(`<br>`  candidates: AttributionCandidate[],`<br>`  incident: IncidentDefinition,`<br>`  config: CairnScoringConfig = {},`<br>`): RankedAttribution {` … `return { ranked: scored, suppressed, incident, config_used: cfg };` |
| S4 | `score.ts` | 116–126 | The suppression that creates the blind spot (post-incident); kernel_underflow at 132–135 | `if (delta < -cfg.grace_seconds) { … suppression_reason: 'post_incident_timestamp' }` … `kernel_value < KERNEL_UNDERFLOW ? { candidate, suppression_reason: 'kernel_underflow' } : null` |
| S5 | `types.ts` | 8–18 | `AttributionCandidate` (input type; `timestamp_unix`, `cause_kind`) | `export interface AttributionCandidate {`<br>`  cause_id: string;`<br>`  cause_kind: CandidateKind;`<br>`  timestamp_unix: number; …` |
| S6 | `types.ts` | 20–26 | `CandidateKind` union (6 kinds; all present as σ-map keys) | `export type CandidateKind =`<br>`  \| 'deploy' \| 'chaos_experiment' \| 'dependency_change'`<br>`  \| 'env_change' \| 'shard_event' \| 'generic';` |
| S7 | `types.ts` | 43–59 | `IncidentDefinition` — `onset_time_unix` is the coverage reference point | `export interface IncidentDefinition {`<br>`  incident_id: string;`<br>`  onset_time_unix: number; …` |
| S8 | `types.ts` | 61–72 | `CairnScoringConfig` — `kernel_sigma_seconds?: Partial<Record<CandidateKind, number>>` | `export interface CairnScoringConfig {`<br>`  kernel_sigma_seconds?: Partial<Record<CandidateKind, number>>; …` |
| S9 | `types.ts` | 102–107 | `config_used.kernel_sigma_seconds` — the full resolved σ map the diagnostic reads | `config_used: {`<br>`    kernel_sigma_seconds: Record<CandidateKind, number>;`<br>`    kind_prior: Record<CandidateKind, number>; …` |
| S10 | `index.ts` | 8–9 | Barrel export point for `score`; new `coverage` export lands alongside | `export { scoreCandidate, rankCandidates } from './score';`<br>`export type { ScoreBreakdown } from './score';` |
| S11 | `tsconfig.json` | 23 | `include` list — `coverage.ts` must be added | `"include": ["index.ts", "score.ts", "ingest.ts", "types.ts"],` |
| S12 | `tools/cairn.js` | 122–155 | `main()` arg parsing + `--json`/`--check` branches — `--coverage` injected here, leaving `buildReport`/`renderAscii` untouched | `const jsonOut = args.includes('--json');`<br>`const checkIdx = args.indexOf('--check');` … |
| S13 | `tools/cairn.js` | 61–72 | `buildReport` — MUST NOT be modified (keeps default report shape) | `function buildReport(incident, candidatesSrc) { … return { cairn_report_version: REPORT_VERSION, incident, ranked, suppressed, config_used }; }` |
| S14 | `demos/cairn-candidates.json` + `cairn-incident.json` | all | Existing fixture that **already exhibits the blind spot** — env_change earliest at 1747686000 (lead 14400s) vs widest σ env_change 21600s; chaos suppressed `kernel_underflow` (`test/q30-cairn-cli.test.ts:35`) | onset `1747700400`; candidates min ts `1747686000`; → `earliest_lead = 14400`, `2×widest_σ = 43200` → **warns** |

---

## Decisions resolved at spec-emit (Q33.1 → Q33.3)

### Q33.1 — Onset reference point: operator vs engine-inferred
The scorer prefers `incident.engine_onset_estimate.center_unix` over
`onset_time_unix` when present (`score.ts:102–110`). **Decision: the diagnostic
uses `incident.onset_time_unix` only**, matching the literal AC-2 wording
("onset − earliest candidate timestamp"). Rationale: the diagnostic is an
**operator-facing** check on *the operator's declared onset and configured
lookback* — a pre-flight "did you cast a wide enough net" gauge — not a probe
of the scorer's internal kernel-centering. Keeping it on `onset_time_unix`
makes it independent of engine inference and trivially explainable. _(See
grilling L1.)_

### Q33.2 — Bandwidth used: kind σ vs engine-quadrature σ
When `engine_onset_estimate` is present the scorer widens σ via quadrature
(`effectiveSigma = sqrt(engineVar + kindVar)`, `score.ts:104–106`).
**Decision: the diagnostic uses the kind σ only** (the resolved
`config_used.kernel_sigma_seconds[kind]`), per AC-2's literal "default/config
kernel σ among the cause_kinds." This is the *conservative* choice — kind σ ≤
quadrature σ, so the 2×σ threshold is never wider than the scorer's actual
kernel, biasing the diagnostic toward warning rather than false reassurance.
_(See grilling L2.)_

### Q33.3 — σ-map source: duplicate constant vs read `config_used`
**Decision: read `rankCandidates([], incident, config).config_used.
kernel_sigma_seconds`** (drift-proof, additive, read-only). Duplicating
`DEFAULT_KERNEL_SIGMA_SECONDS` into `coverage.ts` is rejected — it would drift
the first time the scorer is retuned, exactly the kind of silent divergence
this addition exists to prevent. _(See grilling C1.)_

---

## Implementation surface

### File: `coverage.ts` (new)

```ts
// engine/cairn/coverage.ts — Cairn candidate-coverage diagnostic (Q33).
//
// Pure, read-only measurement layer over the scorer. Warns when the
// candidate lookback window is too narrow to contain a slow-burn cause —
// closing the silent-under-attribution blind spot (chaos/env causes whose
// kernel underflows and are dropped from the ranking with no signal).
//
// Does NOT score, rank, or mutate scorer config/output. Reads the effective
// per-kind σ map via the scorer's public config echo (rankCandidates(...).
// config_used) so the defaults can never drift from score.ts.

import type {
  AttributionCandidate, CandidateKind, IncidentDefinition, CairnScoringConfig,
} from './types';
import { rankCandidates } from './score';

export interface CoverageDiagnostic {
  /** Number of candidates supplied. */
  candidate_count: number;
  /** onset_time_unix − min(candidate.timestamp_unix). null iff no candidates.
   *  May be negative if every candidate post-dates onset. */
  earliest_lead_seconds: number | null;
  /** Largest resolved (default ⊕ config) kernel σ among the cause_kinds
   *  actually present in the candidate set. null iff no candidates. */
  widest_sigma_seconds: number | null;
  /** True iff candidate_count > 0 AND earliest_lead_seconds >= 2×widest σ. */
  adequately_covered: boolean;
  /** Human-readable explanation when coverage is inadequate; null otherwise. */
  warning: string | null;
}

const COVERAGE_SIGMA_MULTIPLE = 2;

/** Inspect candidate-set coverage against incident onset + configured kernel
 *  bandwidths. Pure + deterministic: no RNG, no clock, no mutation. */
export function coverageDiagnostic(
  candidates: AttributionCandidate[],
  incident: IncidentDefinition,
  config: CairnScoringConfig = {},
): CoverageDiagnostic {
  const candidate_count = candidates.length;

  // AC-4: empty set → no throw, not covered, explicit warning.
  if (candidate_count === 0) {
    return {
      candidate_count: 0,
      earliest_lead_seconds: null,
      widest_sigma_seconds: null,
      adequately_covered: false,
      warning:
        'no candidates supplied — coverage cannot be assessed; supply ' +
        'candidate cause-events spanning the lookback window before onset.',
    };
  }

  // Earliest candidate's lead before onset (integer unix seconds → no float).
  let earliestTs = candidates[0].timestamp_unix;
  for (const c of candidates) {
    if (c.timestamp_unix < earliestTs) earliestTs = c.timestamp_unix;
  }
  const earliest_lead_seconds = incident.onset_time_unix - earliestTs;

  // Resolve the effective σ map WITHOUT duplicating the private default
  // constant (Q33.3). Empty-candidate call is O(1) and read-only.
  const sigmaMap = rankCandidates([], incident, config)
    .config_used.kernel_sigma_seconds;

  // Widest σ among the distinct cause_kinds actually present.
  const presentKinds = new Set<CandidateKind>();
  for (const c of candidates) presentKinds.add(c.cause_kind);
  let widest_sigma_seconds = 0;
  for (const k of presentKinds) {
    const s = sigmaMap[k];
    if (s > widest_sigma_seconds) widest_sigma_seconds = s;
  }

  const adequately_covered =
    earliest_lead_seconds >= COVERAGE_SIGMA_MULTIPLE * widest_sigma_seconds;

  const warning = adequately_covered
    ? null
    : `candidate window may be too narrow: earliest candidate leads onset ` +
      `by ${earliest_lead_seconds}s, below ${COVERAGE_SIGMA_MULTIPLE}× the ` +
      `widest configured kernel σ (${widest_sigma_seconds}s) among present ` +
      `cause-kinds. A slow-burn cause earlier than the lookback could be ` +
      `silently under-attributed (kernel-underflow suppression). Widen the ` +
      `candidate lookback to at least ` +
      `${COVERAGE_SIGMA_MULTIPLE * widest_sigma_seconds}s before onset.`;

  return {
    candidate_count,
    earliest_lead_seconds,
    widest_sigma_seconds,
    adequately_covered,
    warning,
  };
}
```

**Notes**
- Pure / deterministic: only arithmetic over integer unix timestamps and the
  resolved σ map. No `Math.random`, no `Date.now`, no wall-clock (NFR-3).
- `earliest_lead_seconds` may be negative (all candidates post-onset); the 2×σ
  comparison handles it correctly (negative < positive → warns).
- Threshold is `>=`, so an earliest lead *exactly* equal to 2×σ is adequate.
- All 6 `CandidateKind` values exist as keys in `config_used.kernel_sigma_
  seconds` (full `Record`, S9), so `sigmaMap[k]` is never `undefined`.

### File: `index.ts` (edit — additive, S10)
Append after the existing `score` exports:
```ts
export { coverageDiagnostic } from './coverage';
export type { CoverageDiagnostic } from './coverage';
```

### File: `tsconfig.json` (edit — additive, S11)
Add `"coverage.ts"` to `include`:
```jsonc
"include": ["index.ts", "score.ts", "ingest.ts", "coverage.ts", "types.ts"],
```

### File: `tools/cairn.js` (edit — additive, opt-in flag; S12/S13)
**Constraints (load-bearing):** `buildReport` (S13) and `renderAscii`
**unchanged**; default (no `--coverage`) output stays **byte-identical**; the
existing `--check` walkthrough fixture (run without `--coverage`) stays green.

- Require `coverageDiagnostic` from `../dist` alongside the existing imports.
- In `main()` parse `const coverageOut = args.includes('--coverage');`.
- After `const report = buildReport(...)`, **only if `coverageOut`**, compute
  `const coverage = coverageDiagnostic(assembleCandidates(candidatesSrc),
  incident, candidatesSrc.config ?? {});` and attach `report.coverage =
  coverage;` **before** the `--check`/`--json` branching.
  - `--json` path then naturally emits the extra `coverage` key (opt-in only).
  - ASCII path: append a `renderCoverage(coverage)` block after the existing
    `renderAscii(report)` output (new helper, additive). The block prints
    `candidate_count`, `earliest_lead_seconds`, `widest_sigma_seconds`,
    `adequately_covered`, and the `warning` (or "coverage adequate").
- `--check` interaction: documented — `--check` compares the emitted report. If
  a user passes **both** `--check` and `--coverage`, their expected fixture must
  include the `coverage` key. The existing fixture/test runs **without**
  `--coverage`, so it is unaffected. Default and `--check`-only paths are
  byte-identical to SHA `6a529cb`.
- Update the usage string to mention `[--coverage]` (string-only change; does
  not alter report bytes).

### File: `demos/cairn-coverage-demo.md` (new — walkthrough; AC-6)
A short doc showing `--coverage` against the **existing** fixture
(`demos/cairn-incident.json` + `demos/cairn-candidates.json`), which is a
genuine narrow-window case that **warns** (env_change earliest lead 14400s <
2×21600s = 43200s; the 90-min chaos experiment is suppressed and never ranked —
S14). Must paste the actual warning output. Per the "demo must include a case
the system gets wrong" reinforcement, this demo's headline is precisely the
blind spot: a confident ranking that the coverage diagnostic flags as
under-covered. For contrast, the doc also shows a widened-config invocation
(e.g. `config.kernel_sigma_seconds.env_change` lowered, or a candidate added
earlier than 43200s) where `adequately_covered: true`.

---

## Tests — `test/q33-cairn-coverage.test.ts` (new)

Tests run against `dist/` via `node --test` (per repo convention; imports from
`../dist/coverage`, `../dist/types`). ≥6 tests, each mapped to an AC.

| # | Test | AC |
|---|------|-----|
| T1 | `coverageDiagnostic` returns an object with all five fields of the documented type/shape (`candidate_count`, `earliest_lead_seconds`, `widest_sigma_seconds`, `adequately_covered`, `warning`). | AC-1, AC-2 |
| T2 | `earliest_lead_seconds === onset − min(timestamp)`; `widest_sigma_seconds === max default σ among present kinds` (e.g. deploy+chaos present → 1800, not 300). | AC-2 |
| T3 | Wide window (earliest lead ≥ 2×widest σ) → `adequately_covered === true`, `warning === null`. Include the exact-boundary case (lead === 2×σ → true). | AC-3 |
| T4 | Narrow window with candidates present → `adequately_covered === false`, `warning` is non-null and mentions slow-burn / widening the lookback. | AC-3 |
| T5 | Empty candidate array → `candidate_count === 0`, `earliest_lead_seconds === null`, `widest_sigma_seconds === null`, `adequately_covered === false`, `warning` contains "no candidates", and the call does **not** throw. | AC-4 |
| T6 | Purity/determinism + read-only: two identical calls deep-equal; a frozen/snapshotted `config` object is unchanged after the call (no mutation of scorer config); no reliance on clock (stable across runs). | AC-5 |
| T7 | Config-override σ is honored & drift-proof: passing `config.kernel_sigma_seconds = { env_change: 9999 }` changes `widest_sigma_seconds` accordingly — proving the σ map is read from the scorer's resolved config, not a hard-coded copy. | AC-2, AC-5 (Q33.3) |
| T8 | CLI: (a) default invocation (no `--coverage`) output is **byte-identical** to a captured baseline; (b) `--coverage` (ASCII + `--json`) surfaces the diagnostic; (c) the demo narrow-window fixture **actually warns** (`adequately_covered === false`, non-null warning). | AC-6 |

---

## Acceptance criteria → coverage map

- **AC-1** — `coverage.ts` exports `coverageDiagnostic(...)`. → module + T1.
- **AC-2** — `CoverageDiagnostic` shape & field semantics. → type + T1/T2/T7.
- **AC-3** — `adequately_covered` iff count>0 ∧ lead ≥ 2×widest σ; warning on
  false-with-candidates. → logic + T3/T4.
- **AC-4** — empty set: count 0, not covered, "no candidates" warning, no
  throw. → early-return + T5.
- **AC-5** — pure/deterministic, additive (no edits to `score.ts` /
  `rankCandidates` / `scoreCandidate` / default CLI output), read-only over
  scorer config. → design + T6/T7.
- **AC-6** — ≥6 tests mapped to ACs; opt-in `--coverage` flag; demo with a
  narrow-window warning case. → T1–T8 + CLI flag + `cairn-coverage-demo.md`.

---

## Anti-scope

Explicitly **NOT** in scope for Q33 (inherits PRD-30 anti-scope ledger
AS-1…AS-7 and `coordination/ANTI-SCOPE-LEDGER.md`):

- **NOT a scoring change.** No edit to `score.ts`, `scoreCandidate`,
  `rankCandidates`, the kernel math, the suppression rules, or the
  `RankedAttribution` / `ScoredCandidate` / `SuppressedCandidate` output shapes.
  The diagnostic is read-only over the scorer.
- **NOT causal inference** (PRD-30 AS-3). No counterfactual / do-calculus / "is
  this the cause" claim. Coverage answers only "is the candidate window wide
  enough to *contain* a slow-burn cause," a window-adequacy gauge — not a
  causal verdict.
- **NOT a new detector family** (PRD-30 AS-2). No `engine/detectors/*` touch.
- **NOT live telemetry / streaming** (PRD-30 NFR-5, AS-7). Operates on the same
  static candidate/incident inputs the scorer already receives.
- **NOT a change to default CLI output.** New capability is strictly behind the
  opt-in `--coverage` flag; default and `--check`-only output remain
  byte-identical to SHA `6a529cb`. The `--check` replay fixture is not broken.
- **NOT auto-widening / auto-remediation.** The diagnostic *warns and suggests*;
  it never mutates the candidate set, re-runs scoring with a wider window, or
  alters config. Acting on the warning is the operator's call.
- **NOT multi-incident / systemic-pattern analysis** (PRD-30 AS-4). One
  incident at a time.
- **NOT a new persisted schema or report version bump.** `cairn_report_version`
  stays `v1`; the `coverage` key only appears under the opt-in flag.

---

## Pre-emit grilling pass

### CRITICAL
- **C1 — σ-default drift.** `DEFAULT_KERNEL_SIGMA_SECONDS` is private to
  `score.ts` (S1) and AC-5 forbids modifying that file, so it cannot be
  imported. **Resolution:** read the merged σ map from
  `rankCandidates([], incident, config).config_used.kernel_sigma_seconds`
  (S3/S9) — drift-proof and additive. Duplicating the constant is rejected.
- **C2 — default CLI output must stay byte-identical** (reinforcement +
  AC-5/AC-6). **Resolution:** `buildReport`/`renderAscii` untouched (S13);
  `report.coverage` attached and the coverage block rendered **only** when
  `--coverage` is present, at the `main()` level (S12). T8(a) asserts the
  no-flag baseline is byte-identical.
- **C3 — must not throw on empty input** (AC-4). **Resolution:** `candidate_
  count === 0` early-return with `null` leads + "no candidates" warning, before
  any `min`/`max` over an empty set. T5 guards it.

### LIKELY-SURFACES (reviewer will probe)
- **L1 — which onset?** Operator `onset_time_unix` vs engine-inferred center.
  Decided in Q33.1: `onset_time_unix` (literal AC-2; operator-facing gauge).
  Documented so the reviewer sees it's deliberate, not an oversight.
- **L2 — kind σ vs quadrature σ.** Decided in Q33.2: kind σ from `config_used`,
  the conservative (warn-biased) choice. Documented.
- **L3 — negative `earliest_lead_seconds`** when every candidate post-dates
  onset. Handled by arithmetic (negative < 2×σ → warns); covered as a case.
- **L4 — boundary at lead === 2×widest σ.** `>=` makes it adequate; pinned in
  T3 so the inequality direction is locked.
- **L5 — `widest_sigma_seconds` value for the empty case.** `null` (consistent
  with `earliest_lead_seconds` null semantics); AC-4 doesn't pin it, so the
  decision is recorded here and asserted in T5.

### PRE-EMPTABLE
- **P1 — reliance on `rankCandidates([])` populating `config_used`.** Stable
  contract (S3 returns `config_used: cfg` unconditionally; empty input skips
  the scoring loop, no throw). Noted as a depended-on invariant.
- **P2 — wiring.** `index.ts` export (S10) + `tsconfig.json` include (S11) are
  required and listed in the implementation surface; omitting either breaks the
  build / the barrel.
- **P3 — `--check` + `--coverage` together.** Documented: the user's fixture
  must then include the `coverage` key; the shipped fixture/test runs without
  `--coverage` and is unaffected.
- **P4 — floating point.** Leads are integer unix-second differences; σ values
  are integers; no float drift in the comparison.
- **P5 — unknown `cause_kind`.** Impossible at the type level (S6 union) and the
  resolved σ map is a total `Record` over all kinds (S9); `sigmaMap[k]` is
  always defined.

---

## Handoff to spec-implementer

Build order: (1) `coverage.ts`; (2) `index.ts` + `tsconfig.json` wiring; (3)
`tools/cairn.js` `--coverage` flag (guard byte-identical default output); (4)
`test/q33-cairn-coverage.test.ts` (T1–T8); (5) `demos/cairn-coverage-demo.md`
with pasted warning output. Build: `tsc` (defaults) + `tsc -p
tsconfig.test.json`; run: `node --test test/*.test.js`. Verify the existing Q30
CLI `--check` test still passes (no-flag path unchanged).

ANCHOR-STATUS: READY
</content>
</invoke>
