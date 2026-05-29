# Q32 — Cairn calibration / backtesting harness spec

_From: Architect. To: Implementer (this session — solo, audit-tier round-scaling per Anchor `11-round-scaling`)._
_Date: 2026-05-29._
_Foundation: [PRD-30-cairn.md](PRD-30-cairn.md) (esp. **SM-2**) + [Q30-CAIRN-ATTRIBUTION-SPEC.md](Q30-CAIRN-ATTRIBUTION-SPEC.md) (the shipped v1 scorer)._
_Type: full implementation brief (inline ceremony). New measurement module over the existing scorer._
_Sequencing: independent of the Q31 confidence branch. Builds on `main` (the v1 scorer)._

_Framework: Anchor methodology (Q-NN-SPEC-TEMPLATE; Architect role; T0 anchor)._

---

## Spec

Cairn ranks candidates and (post-Q31) reports how *confident* it is. But **nobody has measured whether Cairn's posteriors are actually right.** PRD-30 SM-2 is an explicit calibration target — "the ranked report's top candidate matches the postmortem author's independent best-guess in ≥ 75% of trials (calibration target)" — and there is **zero tooling to measure it**. A confidence number ("deploy 80.7%") is only worth trusting if, across many incidents, the things Cairn calls 80% actually turn out to be the cause ~80% of the time.

This cycle adds a **calibration / backtesting harness**: given a set of *labeled* incidents (each carrying the known true cause), run the v1 scorer over all of them and report accuracy + calibration metrics. It turns SM-2 from an aspiration into a number an operator (or this repo's CI) can track.

Lands as: (a) a pure `calibrate()` in a new `calibration.ts`; (b) typed contracts in `types.ts`; (c) a CLI `tools/cairn-calibrate.js` (ASCII + `--json`); (d) a labeled demo fixture; (e) ≥ 10 tests; (f) a barrel export. **Measurement only — no auto-tuning, no live telemetry, no scorer change.**

### Constraint — measurement, not optimization

The harness **measures** calibration; it does **not** learn or auto-tune priors/σ. Prior-learning is a distinct future capability (it changes the scorer); calibration must stay a read-only diagnostic so it can serve as an honest, stable yardstick *for* any future tuning. (Anti-gold-plating + separation of concerns.)

### Constraint — the demo must not be self-confirming

A calibration demo that reports 100% accuracy / 0 error would be a self-confirming artifact: it would "prove" the scorer is perfect by construction. The demo fixture **must include at least one scenario Cairn mis-ranks**, so the reported metrics are non-trivial (top-1 < 1.0, Brier > 0, a visible reliability gap). The Reviewer verifies this. (Anchor `13-anti-self-confirming-test` applied at the fixture level.)

---

## Architectural mechanism

One pure function in `calibration.ts` over the **existing** `rankCandidates`. For each labeled scenario it runs the scorer once, locates the true cause in the result, and aggregates.

**Per-scenario quantities** (from `ranked = rankCandidates(candidates, incident, config)`):

- `true_cause_rank` — 1-based index of the candidate whose `cause_id === true_cause_id` in `ranked.ranked`; `null` if the true cause is suppressed or absent from the ranked set.
- `true_cause_posterior` — that candidate's `posterior`, or `0` if not ranked.
- `predicted_top_cause_id` — `ranked.ranked[0]?.candidate.cause_id ?? null`.
- `hit@k` — `true_cause_rank !== null && true_cause_rank <= k`.
- `reciprocal_rank` — `true_cause_rank ? 1 / true_cause_rank : 0`.
- `top_confidence` — `ranked.ranked[0]?.posterior ?? 0`; `top_correct` — `predicted_top_cause_id === true_cause_id`.
- `brier` — **multi-class Brier** over the scenario's full candidate set: `Σ_c (p_c − y_c)²` where `y_c = (c.cause_id === true_cause_id ? 1 : 0)` and `p_c =` the candidate's `posterior` if ranked, else `0` (suppressed candidates contribute `p_c = 0`). A suppressed true cause therefore costs the full `(0−1)² = 1`.

**Aggregate metrics** (`CalibrationReport`):

- `n`, `top1_accuracy = mean(top_correct)`, `topk_accuracy = [{k, accuracy}]` for `k ∈ k_values` (default `[1, 3]`).
- `mrr = mean(reciprocal_rank)`.
- `brier_score = mean(brier)` (lower = better calibrated).
- **`reliability_bins`** — partition scenarios by `top_confidence` into `B` equal-width bins (default 10: `[0,0.1), …, [0.9,1.0]`, top bin closed). Per non-empty bin: `{ lower, upper, count, mean_confidence, empirical_accuracy }`, where `empirical_accuracy = mean(top_correct)` within the bin. This is the reliability-diagram data — the honest "does 80% mean 80%?" picture.
- **`ece`** (expected calibration error) — `Σ_bins (count/n) · |mean_confidence − empirical_accuracy|` over non-empty bins. The single calibration scalar.

Bin index: `Math.min(B − 1, Math.floor(conf * B))` (so `conf === 1.0` lands in the last bin).

**Determinism:** pure, no RNG, no clock. Same scenarios → byte-identical report (replay-clean, consistent with NFR-3).

---

## Existing architectural surface (REVIEWER-ANCHOR — mandatory)

Pinned SHA `6a529cb` (`main` HEAD = `feat/calibration-harness` base). Lines opened via this session's Read tool calls, 2026-05-29.

| Inherited file | Pinned SHA | Lines opened | Verbatim snippet | Why it matters to Q32 |
|---|---|---|---|---|
| `score.ts` | `6a529cb` | 142–181 | `export function rankCandidates(candidates, incident, config): RankedAttribution { ... scored.sort((a, b) => { if (b.posterior !== a.posterior) return b.posterior - a.posterior; return a.candidate.timestamp_unix - b.candidate.timestamp_unix; }); return { ranked: scored, suppressed, incident, config_used: cfg }; }` | `calibrate()` calls this once per scenario; `true_cause_rank` is the index into the returned `ranked`. Calibration reads, never reimplements, scoring. |
| `types.ts` | `6a529cb` | 74–84 | `export interface ScoredCandidate { candidate: AttributionCandidate; posterior: number; raw_score: number; kernel_value: number; kind_prior: number; evidence_boost: number; }` | `top_confidence` / `true_cause_posterior` read `posterior`; `predicted_top_cause_id` reads `candidate.cause_id`. |
| `types.ts` | `6a529cb` | 86–91 | `export interface SuppressedCandidate { candidate: AttributionCandidate; suppression_reason: 'post_incident_timestamp' \| 'kernel_underflow'; }` | A suppressed true cause has `rank = null`, `posterior = 0`, and a full Brier penalty. Calibration must read `suppressed` to enumerate the full candidate set for Brier. |
| `types.ts` | `6a529cb` | 93–108 | `export interface RankedAttribution { ranked: ScoredCandidate[]; suppressed: SuppressedCandidate[]; incident: IncidentDefinition; config_used: {...}; }` | The shape `calibrate()` consumes per scenario. Not modified. |
| `types.ts` | `6a529cb` | 8–18 | `export interface AttributionCandidate { cause_id: string; cause_kind: CandidateKind; timestamp_unix: number; evidence_ref: string; metadata?: CandidateMetadata; }` | `LabeledScenario.candidates` and `true_cause_id` reference `cause_id`. |

**Architect self-attest checklist:**

- [x] Files opened at brief-drafting time via this session's Read tool calls.
- [x] Snippet citations verbatim from pinned SHA `6a529cb`.
- [x] Line numbers verified against file content at the pinned SHA.

---

## Implementation surface

### File: `types.ts` (extend — append only)

```ts
// ── Q32 — calibration / backtesting (measurement layer) ─────────────────────

/** One labeled incident for backtesting: the inputs Cairn would score, plus
 *  the post-confirmed true cause. candidates are pre-assembled (decoupled from
 *  ingest) so the harness scores exactly what the operator would. */
export interface LabeledScenario {
  incident: IncidentDefinition;
  candidates: AttributionCandidate[];
  config?: CairnScoringConfig;
  /** cause_id of the candidate the postmortem confirmed as the cause. */
  true_cause_id: string;
}

export interface CalibrationOptions {
  /** Top-k cutoffs to report. Default [1, 3]. */
  k_values?: number[];
  /** Reliability-bin count over the top-candidate confidence. Default 10. */
  bin_count?: number;
}

export interface ScenarioOutcome {
  incident_id: string;
  true_cause_id: string;
  predicted_top_cause_id: string | null;
  /** 1-based rank of the true cause in ranked[]; null if suppressed/absent. */
  true_cause_rank: number | null;
  true_cause_posterior: number;
  top_confidence: number;
  top_correct: boolean;
  reciprocal_rank: number;
  brier: number;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  mean_confidence: number;
  empirical_accuracy: number;
}

export interface CalibrationReport {
  n: number;
  top1_accuracy: number;
  topk_accuracy: { k: number; accuracy: number }[];
  mrr: number;
  brier_score: number;
  ece: number;
  reliability_bins: ReliabilityBin[];
  per_scenario: ScenarioOutcome[];
}
```

### File: `calibration.ts` (new — pure functions, no I/O, no RNG)

```ts
import type {
  LabeledScenario, CalibrationOptions, CalibrationReport,
  ScenarioOutcome, ReliabilityBin,
} from './types';
import { rankCandidates } from './score';

export const DEFAULT_K_VALUES: readonly number[] = [1, 3];
export const DEFAULT_BIN_COUNT = 10;

export function scoreScenario(scenario: LabeledScenario): ScenarioOutcome { ... }   // per-scenario quantities
export function reliabilityBins(outcomes: ScenarioOutcome[], binCount: number): ReliabilityBin[] { ... }
export function calibrate(scenarios: LabeledScenario[], opts?: CalibrationOptions): CalibrationReport { ... }
```

Exact rules: per the Architectural-mechanism section. `scoreScenario` enumerates the full candidate set as `ranked ∪ suppressed` for Brier. `calibrate` guards `n === 0` (all metrics `0`, empty bins). ECE skips empty bins. If `true_cause_id` matches more than one candidate (malformed input), take the best (lowest) rank — note in a code comment.

### File: `index.ts` (extend barrel)

Add `calibrate`, `scoreScenario`, `reliabilityBins`, `DEFAULT_K_VALUES`, `DEFAULT_BIN_COUNT` and the new type exports.

### File: `tools/cairn-calibrate.js` (new — CLI)

Reads a scenarios JSON file `{ scenarios: LabeledScenario[], options?: CalibrationOptions }`, calls `calibrate`, prints an ASCII report (top-1/top-3 accuracy, MRR, Brier, ECE, a reliability table, and a per-scenario hit/miss list). `--json` emits the `CalibrationReport`. Replay-clean.

### File: `demos/cairn-calibration-scenarios.json` (new — labeled fixture)

≥ 4 labeled scenarios. **At least one must be a scenario Cairn mis-ranks** (e.g. the true cause is a low-prior `env_change` that a closer-in-time but innocent deploy out-ranks), so `top1_accuracy < 1`, `brier_score > 0`, and the reliability table shows a real gap. Document the intended outcome inline.

---

## Tests — `test/q32-cairn-calibration.test.ts` (new, ≥ 10)

1. Perfect single scenario (true cause ranks #1) → `top1_accuracy === 1`, `mrr === 1`, that scenario's `brier` small.
2. True cause at rank 2 → `reciprocal_rank === 0.5`, `hit@1` false, `hit@3` true.
3. True cause **suppressed** → `true_cause_rank === null`, `reciprocal_rank === 0`, `brier ≥ 1` (full miss on the true class).
4. `top1_accuracy` over a mixed set (some right, some wrong) equals the hand-computed fraction.
5. `topk_accuracy` for `k=3` ≥ `k=1` (monotone) and matches hand count.
6. `mrr` over a known set equals the hand-computed mean of reciprocal ranks.
7. Multi-class **Brier**: a scenario with posteriors `{true:0.7, other:0.3}` → `brier === 0.3² + 0.3² = 0.18` (kills a squared-error mutation).
8. **Reliability bins**: a constructed set where high-confidence predictions are often wrong → a bin whose `mean_confidence` ≫ `empirical_accuracy` (over-confidence visible).
9. **ECE**: a constructed set with a known confidence/accuracy gap → `ece` equals the hand-computed value (kills a bin-weight mutation).
10. Empty scenario set → `n === 0`, all metrics `0`, `reliability_bins` empty (no divide-by-zero).
11. Determinism / replay-clean: two identical `calibrate` calls → `JSON.stringify` equal.
12. CLI end-to-end on the demo fixture: `--json` parses, `top1_accuracy < 1` (proves the fixture is not self-confirming), `0 ≤ ece ≤ 1`.

---

## Anti-scope

Per [`skills/06-anti-scope-ledger.md`](https://github.com/johnpatrickwarren-oss/anchor/blob/main/skills/06-anti-scope-ledger.md):

- **NO prior/σ auto-tuning or learning.** Calibration measures; it never mutates the scorer's config or output. (Prior-learning is a separate future capability.)
- **NO change to `rankCandidates` / `scoreCandidate`.** Read-only over their output; `score.ts` untouched.
- **NO live customer telemetry** (NFR-5 / PRD-30 AS-1). Operates on operator-supplied labeled scenarios (synthetic fixtures).
- **NO RNG.** Deterministic aggregation; replay-clean.
- **NO causal-inference framing** (PRD-30 AS-3). Metrics describe *ranking accuracy & calibration*, never "causal correctness."
- **NO new detector family** (Q2.B.6.4 ADR, inherited).
- **NO multi-incident *attribution*** (AS-4). Calibration runs many *independent* one-incident attributions and aggregates *metrics* — it does not do cross-incident *RCA*. (Boundary called out explicitly so it isn't mistaken for AS-4.)

---

## Open questions (deferred)

1. **OQ-Q32.1:** Should the CLI also accept raw source shapes (`ds_records`, etc.) and assemble candidates via the ingest helpers, like `tools/cairn.js`? Architect lean: v1 takes pre-assembled `candidates` (decoupled, simplest honest scope); source-assembly is a trivial follow-on. Implementer wires pre-assembled.
2. **OQ-Q32.2:** Reliability binning is equal-width; equal-frequency (quantile) bins are more robust when confidence clusters. Architect lean: equal-width at v1 (matches the canonical reliability-diagram convention); quantile bins are Slice 2.

---

## Architect grilling output (T0)

| Concern | Status |
|---|---|
| **CRITICAL — self-confirming demo.** A calibration harness whose own fixture scores 100%/0-error "proves" nothing and is the textbook self-confirming artifact. | **PRE-EMPTED + ENFORCED.** The fixture MUST contain ≥ 1 mis-ranked scenario; test #12 asserts `top1_accuracy < 1` on the demo; Reviewer verifies. Stated as a hard constraint, not a nicety. |
| **LIKELY-SURFACES — suppressed/absent true cause.** If the true cause is suppressed (post-incident) or simply not in the candidate set, naive rank-lookup returns `-1`/`undefined` and silently corrupts MRR and Brier. | **PRE-EMPTED.** `true_cause_rank = null` when not found; `reciprocal_rank = 0`; Brier enumerates `ranked ∪ suppressed` and charges the full `(0−1)²` for a missing/suppressed true class. Test #3 covers it. |
| **LIKELY-SURFACES — empty inputs / empty bins.** `n === 0` ⇒ divide-by-zero in every mean; an empty reliability bin ⇒ divide-by-zero in `mean_confidence`. | **PRE-EMPTED.** `n === 0` short-circuits to all-zero; ECE and bin construction skip empty bins. Test #10 covers it. |
| **PRE-EMPTABLE — Brier definition drift.** "Brier score" is ambiguous (binary vs multi-class; sum vs mean over classes). An undocumented choice invites a silent off-by-definition. | **FIXED + DOCUMENTED.** Multi-class Brier = `Σ_c (p_c − y_c)²` per scenario, meaned over scenarios; spelled out with a worked value in test #7. |
| **PRE-EMPTABLE — bin boundary at 1.0.** `floor(1.0 * B) = B` overflows the bin array. | **PRE-EMPTED.** `Math.min(B − 1, floor(conf·B))`. |
| **Anti-scope honesty** — does "calibration" drift into "auto-tuning" (mutating the scorer)? | **GUARDED.** Measurement-only constraint stated twice; anti-scope bullet 1. |
| Q2.B.6.4 ADR — any `engine/detectors/*` touch? | **NO.** New `calibration.ts` module; reads `rankCandidates` output only. |

**Memorial F sub-rules:**

- **Sub-rule 2 (schema-precedent-recheck):** New types appended; no existing interface edited; no wire-schema change.
- **Sub-rule 3 (acceptance-criterion-coherence):** Every metric has a hand-computed test; the self-confirming guard has an explicit test (#12).
- **Sub-rule 4 (pre-existing-property-coherence):** scorer untouched (`score.ts` byte-identical); replay-clean preserved (no RNG); no-skip (all Q32 tests assert).

---

_Spec based on Anchor Q-NN-SPEC-TEMPLATE + `08-architect-six-practices` + `03-four-anchor-defense` (T0) + `01-pre-emit-grilling` + `13-anti-self-confirming-test` (applied to the demo fixture). Cross-references PRD-30 SM-2 + Q30 for traceability._
