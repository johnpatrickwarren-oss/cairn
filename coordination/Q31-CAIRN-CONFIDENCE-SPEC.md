# Q31 — Cairn attribution confidence & robustness spec

_From: Architect. To: Implementer (this session — solo, audit-tier round-scaling per Anchor `11-round-scaling`)._
_Date: 2026-05-29._
_Foundation: [PRD-30-cairn.md](PRD-30-cairn.md) + [Q30-CAIRN-ATTRIBUTION-SPEC.md](Q30-CAIRN-ATTRIBUTION-SPEC.md) (the shipped v1 attribution surface)._
_Type: full implementation brief (inline ceremony). Additive feature on top of the shipped v1 scorer._
_Sequencing: independent of in-flight work. Substantive product layer (real confidence math), not positioning._

_Framework: Anchor methodology (Q-NN-SPEC-TEMPLATE; Architect role; T0 anchor)._

---

## Spec

Cairn v1 emits a bare point-posterior per candidate: "deploy 80.7%, env_change 14.7%, …". That number answers *"which candidate is most timing-consistent"* but **not** *"how much should I trust that ranking"*. Two distinct questions go unanswered today:

1. **Decisiveness** — is the #1 a clear winner, or is it 34% vs 31% (a statistical coin-flip the operator should NOT write into a postmortem as "the cause")?
2. **Robustness** — does the #1 ranking survive the onset being a few minutes off? The onset time is itself an estimate (PagerDuty alert lag, oncall report). If nudging onset by ±1σ flips the top candidate, the ranking is fragile and the operator deserves to know.

Cairn's entire pitch is *"statistically, not by eyeballing dashboards."* Shipping a single posterior with no uncertainty band is itself a kind of eyeballing. This cycle adds a **confidence & robustness layer** that makes Cairn honest about its own certainty — directly serving the P1 SRE's "defensibly" need and the SM-2 calibration target.

Lands as: (a) two pure functions in a new `confidence.ts`; (b) typed contracts in `types.ts`; (c) an **opt-in** `--confidence` CLI flag; (d) ≥ 10 tests; (e) a barrel export. **No new detector family, no causal-inference framing, no live telemetry** — preserves every PRD-30 anti-scope clause.

### Load-bearing constraint — additive & replay-clean

This feature is **strictly additive**. It must NOT change the output shape of `rankCandidates` or the default CLI output. Rationale:

- `NFR-3` (replay-clean) and `AC-6`/`AC-8` are anchored on the `demos/cairn-attribution-walkthrough.json` fixture being **byte-identical** under `--check`. Mutating `RankedAttribution` would break that fixture and any downstream consumer of the v1 shape.
- Therefore confidence is computed by **separate functions** over the existing output, and the CLI surfaces it only behind `--confidence`. Default output and the `--check` replay path stay byte-identical. (Anchor Memorial F sub-rule 4: pre-existing-property-coherence / back-compat.)

### Determinism constraint — no RNG

Robustness perturbs the onset over a **fixed, deterministic grid** of σ-multiples (not Monte-Carlo sampling). RNG would violate NFR-3 (replay-clean) — the product's load-bearing audit-substrate invariant. The grid is the principled choice: it is reproducible months later from the same inputs, which is the whole point of Cairn being an audit substrate.

---

## Architectural mechanism

Two pure functions in `confidence.ts`, operating on the **existing** scoring surface.

### 1. Decisiveness — intra-distribution, zero re-ranking

Reads the already-sorted `RankedAttribution.ranked` posteriors `p₁ ≥ p₂ ≥ … ≥ pₙ`:

- **`top_margin`** = `n ≥ 2 ? p₁ − p₂ : (n === 1 ? 1 : 0)`. The gap between #1 and #2. A 0.50 margin is decisive; a 0.03 margin is a coin-flip.
- **`entropy_bits`** = `−Σ pᵢ·log₂(pᵢ)` over ranked candidates with `pᵢ > 0`. Shannon entropy of the posterior. Low = concentrated; high = spread.
- **`entropy_normalized`** = `n ≥ 2 ? entropy_bits / log₂(n) : 0`. Scales to `[0,1]` (0 = a single candidate holds all mass; 1 = uniform over n). Comparable across incidents with different candidate counts.
- **`label`** ∈ `{ 'no_candidates', 'decisive', 'contested', 'ambiguous' }`, from `top_margin` against operator-tunable thresholds (defaults: `decisive ≥ 0.5`, `contested ≥ 0.15`, else `ambiguous`; `no_candidates` when `n === 0`). The label is the honest one-word summary the postmortem author reads first.

Thresholds live in an optional `DecisivenessThresholds` config — same operator-tunable-knob posture the Q30 spec took for `evidence_boost` (a calibration knob, not a load-bearing constant).

### 2. Robustness — perturbation stability over the onset estimate

Re-ranks under a deterministic grid of onset perturbations and reports whether the top candidate holds:

```
σ      = opts.onset_sigma_seconds
        ?? incident.engine_onset_estimate?.sigma_seconds
        ?? DEFAULT_ONSET_JITTER_SECONDS   (300 = 5 min)
grid   = opts.sigma_multipliers ?? [-2, -1, -0.5, 0.5, 1, 2]   // excludes 0 (= baseline)
baseline      = rankCandidates(candidates, incident, config)
baseTopId     = baseline.ranked[0]?.candidate.cause_id ?? null
for m in grid:
    offset    = m * σ
    perturbed = incident with onset_time_unix += offset
                (and engine_onset_estimate.center_unix += offset when present,
                 since that supersedes onset for the kernel — Q30.1)
    r         = rankCandidates(candidates, perturbed, config)
    trial     = { sigma_multiple: m, offset_seconds: offset,
                  top_cause_id: r.ranked[0]?.candidate.cause_id ?? null,
                  top_posterior: r.ranked[0]?.posterior ?? 0 }
top_stability = trials.length ? (#trials where top_cause_id === baseTopId) / trials.length : 1
flips         = trials where top_cause_id !== baseTopId
```

Output `RobustnessReport = { baseline_top_cause_id, onset_sigma_seconds_used, top_stability ∈ [0,1], trials[], flips[] }`. `top_stability === 1` means the #1 held across every perturbation (robust); `< 1` with `flips` populated tells the operator exactly which onset shift dethrones it.

**Why perturb the onset and not the kernel σ?** Onset is the dominant uncertainty source and the one Cairn already carries a principled σ for (`engine_onset_estimate.sigma_seconds`, Q30.1). Kernel-σ sensitivity is a clean Slice-2 deferral — see Anti-scope. (Anti-gold-plating: don't widen the perturbation surface beyond the uncertainty we can actually quantify at v1.)

---

## Existing architectural surface (REVIEWER-ANCHOR — mandatory)

Pinned SHA `6a529cb` (branch `feat/attribution-confidence` base = `main` HEAD at cycle start). Lines opened via this session's Read tool calls, 2026-05-29.

| Inherited file | Pinned SHA | Lines opened | Verbatim snippet | Why it matters to Q31 |
|---|---|---|---|---|
| `score.ts` | `6a529cb` | 142–181 | `export function rankCandidates(...): RankedAttribution { ... scored.sort((a, b) => { if (b.posterior !== a.posterior) return b.posterior - a.posterior; return a.candidate.timestamp_unix - b.candidate.timestamp_unix; }); ... }` | Robustness **re-invokes** `rankCandidates` per perturbation; decisiveness reads its sorted `posterior`. Confidence does not reimplement scoring. |
| `score.ts` | `6a529cb` | 167–168 | `const total = scored.reduce((acc, s) => acc + s.raw_score, 0); for (const s of scored) s.posterior = total > 0 ? s.raw_score / total : 0;` | Posteriors sum to 1 over the ranked set ⇒ entropy/margin are well-defined; the `total === 0` branch is the edge decisiveness must guard. |
| `types.ts` | `6a529cb` | 74–84 | `export interface ScoredCandidate { candidate: AttributionCandidate; /** Normalized posterior (sums to 1.0 across the ranked set). */ posterior: number; ... }` | Decisiveness consumes `ranked: ScoredCandidate[]` posteriors. New types reference, do not modify, this. |
| `types.ts` | `6a529cb` | 93–108 | `export interface RankedAttribution { ranked: ScoredCandidate[]; suppressed: SuppressedCandidate[]; incident: IncidentDefinition; config_used: {...}; }` | **NOT modified** — the back-compat anchor. Confidence types are added alongside, never folded in. |
| `types.ts` | `6a529cb` | 43–59 | `export interface IncidentDefinition { ... onset_time_unix: number; ... engine_onset_estimate?: { center_unix: number; sigma_seconds: number; }; }` | Robustness perturbs `onset_time_unix` (and `engine_onset_estimate.center_unix` when present, per Q30.1). |
| `tools/cairn.js` | `6a529cb` | 61–72 | `function buildReport(...) { ... return { cairn_report_version: REPORT_VERSION, incident, ranked: ..., suppressed: ..., config_used: ... }; }` | `--confidence` adds a `confidence` field to this envelope **only when the flag is set** — default envelope unchanged. |
| `tools/cairn.js` | `6a529cb` | 138–148 | `if (checkPath) { ... const ok = JSON.stringify(actual) === JSON.stringify(expected); ... }` | The byte-identical `--check` replay path. Default (no `--confidence`) output must stay identical so the existing walkthrough fixture still verifies. |

**Architect self-attest checklist:**

- [x] Files opened at brief-drafting time via this session's Read tool calls.
- [x] Snippet citations verbatim from pinned SHA `6a529cb`.
- [x] Line numbers verified against file content at the pinned SHA.

---

## Implementation surface

### File: `types.ts` (extend — append only, do not edit existing interfaces)

```ts
/** Honest one-word + numeric summary of how clear-cut the top ranking is. */
export interface DecisivenessThresholds {
  /** top_margin ≥ this ⇒ 'decisive'. Default 0.5. */
  decisive?: number;
  /** top_margin ≥ this (and < decisive) ⇒ 'contested'. Default 0.15. */
  contested?: number;
}

export interface Decisiveness {
  /** posterior gap between #1 and #2 (1.0 if a single candidate; 0 if none). */
  top_margin: number;
  /** Shannon entropy of the posterior distribution, in bits. */
  entropy_bits: number;
  /** entropy_bits / log2(n), in [0,1]; 0 = one candidate holds all mass. */
  entropy_normalized: number;
  label: 'no_candidates' | 'decisive' | 'contested' | 'ambiguous';
  /** Echo of the thresholds applied (defaults filled in). */
  thresholds_used: { decisive: number; contested: number };
}

export interface RobustnessOptions {
  /** Onset jitter σ in seconds. Falls back to engine_onset_estimate.sigma_seconds,
   *  then to DEFAULT_ONSET_JITTER_SECONDS (300). */
  onset_sigma_seconds?: number;
  /** σ-multiples to probe. Default [-2,-1,-0.5,0.5,1,2]. Deterministic (no RNG). */
  sigma_multipliers?: number[];
}

export interface RobustnessTrial {
  sigma_multiple: number;
  offset_seconds: number;
  top_cause_id: string | null;
  top_posterior: number;
}

export interface RobustnessReport {
  baseline_top_cause_id: string | null;
  onset_sigma_seconds_used: number;
  /** Fraction of perturbation trials whose top candidate matched the baseline. */
  top_stability: number;
  trials: RobustnessTrial[];
  flips: RobustnessTrial[];
}
```

### File: `confidence.ts` (new — pure functions, no I/O, no RNG)

```ts
import type {
  AttributionCandidate, IncidentDefinition, CairnScoringConfig, RankedAttribution,
  Decisiveness, DecisivenessThresholds, RobustnessOptions, RobustnessReport,
} from './types';
import { rankCandidates } from './score';

export const DEFAULT_DECISIVE_MARGIN = 0.5;
export const DEFAULT_CONTESTED_MARGIN = 0.15;
export const DEFAULT_ONSET_JITTER_SECONDS = 300;
export const DEFAULT_SIGMA_MULTIPLIERS: number[] = [-2, -1, -0.5, 0.5, 1, 2];

export function decisiveness(ranked: RankedAttribution, thresholds?: DecisivenessThresholds): Decisiveness { ... }
export function robustness(
  candidates: AttributionCandidate[], incident: IncidentDefinition,
  config?: CairnScoringConfig, opts?: RobustnessOptions,
): RobustnessReport { ... }
```

`decisiveness` math (exact):
- `ps = ranked.ranked.map(s => s.posterior)`; `n = ps.length`.
- `top_margin = n >= 2 ? ps[0] - ps[1] : (n === 1 ? 1 : 0)`.
- `entropy_bits = -ps.filter(p => p > 0).reduce((a, p) => a + p * Math.log2(p), 0)`.
- `entropy_normalized = n >= 2 ? entropy_bits / Math.log2(n) : 0`.
- `label`: `n === 0 → 'no_candidates'`; else `top_margin >= decisive → 'decisive'`; `top_margin >= contested → 'contested'`; else `'ambiguous'`.

`robustness` math: exactly as the Architectural-mechanism pseudo-code. Perturb a **copy** of `incident` (never mutate the caller's object). When `engine_onset_estimate` is present, shift both `onset_time_unix` and `engine_onset_estimate.center_unix` by the same offset.

### File: `index.ts` (extend barrel)

Add: `export { decisiveness, robustness, DEFAULT_DECISIVE_MARGIN, DEFAULT_CONTESTED_MARGIN, DEFAULT_ONSET_JITTER_SECONDS, DEFAULT_SIGMA_MULTIPLIERS } from './confidence';` and the new type exports.

### File: `tools/cairn.js` (extend — opt-in only)

- Parse `--confidence` flag.
- When set: compute `decisiveness(ranked)` and `robustness(candidates, incident, config)`, attach as `report.confidence = { decisiveness, robustness }`, and render an extra ASCII section (label, margin, entropy, top_stability, any flips). When **not** set: envelope and ASCII byte-identical to today.
- `--check` continues to compare the default (no-confidence) report ⇒ existing fixture unaffected.

---

## Tests — `test/q31-cairn-confidence.test.ts` (new, ≥ 10)

Decisiveness:
1. Single ranked candidate ⇒ `top_margin === 1`, `entropy_normalized === 0`, label `'decisive'`.
2. Zero ranked candidates ⇒ label `'no_candidates'`, margin 0.
3. Near-uniform two-candidate posterior (e.g. 0.51/0.49) ⇒ label `'ambiguous'`, small margin, `entropy_normalized` near 1.
4. Clear winner (≥ 0.5 margin) ⇒ label `'decisive'`.
5. Mid margin (0.15 ≤ m < 0.5) ⇒ label `'contested'`.
6. Custom thresholds override defaults (relabels the same distribution).
7. Entropy: a uniform n=2 distribution has `entropy_bits ≈ 1.0` and `entropy_normalized ≈ 1.0` (kills a log-base mutation).

Robustness:
8. A well-separated incident (deploy dominant) ⇒ `top_stability === 1`, `flips` empty.
9. A fragile incident engineered so a ±σ onset shift flips the top ⇒ `top_stability < 1` and `flips` non-empty with the expected `top_cause_id`.
10. `robustness` does **not** mutate the caller's `incident` (assert `incident.onset_time_unix` unchanged after the call).
11. Deterministic: two identical calls ⇒ `JSON.stringify` equal (replay-clean).
12. `onset_sigma_seconds` from `engine_onset_estimate` is used when `opts` omits it.

Back-compat (the anchor):
13. `rankCandidates` output shape is unchanged — the existing `--check` walkthrough fixture still verifies byte-identical (run in the CLI test or asserted directly).

---

## Anti-scope

Per [`skills/06-anti-scope-ledger.md`](https://github.com/johnpatrickwarren-oss/anchor/blob/main/skills/06-anti-scope-ledger.md):

- **NO change to `rankCandidates` / `scoreCandidate` output shape.** Confidence is computed by separate functions over the existing output. Back-compat byte-identical (replay fixture preserved).
- **NO RNG / Monte-Carlo.** Deterministic σ-grid only — NFR-3 replay-clean preserved.
- **NO new detector family, NO `engine/detectors/*` semantics.** Confidence is a read-layer atop the scorer (Q2.B.6.4 ADR preserved, inherited from Q30).
- **NO causal-inference framing** (PRD-30 AS-3). Output language stays "ranking confidence / robustness of timing-consistent candidates," never "causal confidence."
- **NO kernel-σ perturbation at v1** — onset-center only (deferred, OQ-Q31.1).
- **NO multi-incident / cross-incident confidence** (PRD-30 AS-4 preserved).
- **NO narrative auto-gen, web UI, streaming** (PRD-30 AS-5/6/7 preserved).

---

## Open questions (deferred)

1. **OQ-Q31.1:** Should robustness also perturb the per-kind kernel σ (not just onset center)? Architect lean: yes eventually, but onset is the dominant + only principled-σ uncertainty at v1; kernel-σ sensitivity is Slice 2. Implementer wires onset-only; flags if trivially extensible.
2. **OQ-Q31.2:** Should `decisiveness` enter the default `RankedAttribution` output once a v2 schema bump is acceptable (it's cheap and pure)? Architect lean: yes at the next intentional schema-version bump, NOT this cycle (would break the v1 replay fixture). Tracked, not done.

---

## Architect grilling output (T0)

| Concern | Status |
|---|---|
| **CRITICAL — back-compat.** Does any part of this change `RankedAttribution` or the default CLI output and silently break the `--check` walkthrough fixture (AC-6/AC-8/NFR-3)? | **CHECKED — NO.** Confidence is separate functions + opt-in `--confidence` flag. Test #13 asserts the fixture still verifies. This is the load-bearing constraint, stated twice in the spec. |
| **LIKELY-SURFACES — entropy of a zero/degenerate posterior.** `Math.log2(0) = -Infinity`; `0 * -Infinity = NaN`. A ranked candidate with `posterior === 0` (the `total === 0` branch in score.ts:168) would poison `entropy_bits`. | **PRE-EMPTED.** Entropy sums only over `p > 0` (filter before the `p·log2 p`). The `n < 2` cases short-circuit `entropy_normalized` to 0 (avoids `log2(1) = 0` divide-by-zero). Test #2 + the single-candidate case (#1) cover it. |
| **LIKELY-SURFACES — mutation of the caller's incident.** Robustness perturbs `onset_time_unix`; a naive in-place edit corrupts the caller's object across trials and after return. | **PRE-EMPTED.** Each trial builds a fresh shallow copy (and a fresh nested `engine_onset_estimate`). Test #10 asserts the input is untouched. |
| **PRE-EMPTABLE — RNG temptation.** "Sample N random onset offsets" is the textbook robustness approach but breaks replay-clean. | **PRE-EMPTED.** Fixed deterministic grid; stated as a hard constraint. Test #11 asserts byte-identical repeat. |
| **PRE-EMPTABLE — threshold magic numbers.** `0.5` / `0.15` are arbitrary. | **ACCEPTED + tunable.** Same posture as Q30's `evidence_boost`: operator-tunable via `DecisivenessThresholds`, defaults documented as calibration knobs not load-bearing constants. Test #6 exercises override. |
| **Honesty check** — does "confidence" language drift toward "causal confidence"? | **GUARDED.** Anti-scope bullet pins the language to "ranking confidence / robustness." |

**Memorial F sub-rules:**

- **Sub-rule 2 (schema-precedent-recheck):** New types appended; no existing interface edited; no wire-schema change.
- **Sub-rule 3 (acceptance-criterion-coherence):** Every test maps to a spec mechanism; the back-compat anchor has an explicit test (#13).
- **Sub-rule 4 (pre-existing-property-coherence):** replay-clean preserved (deterministic grid + opt-in flag); v1 output byte-identical; no-skip (all Q31 tests assert).

---

_Spec based on Anchor Q-NN-SPEC-TEMPLATE + `08-architect-six-practices` + `03-four-anchor-defense` (T0) + `01-pre-emit-grilling`. Cross-references PRD-30 + Q30 for traceability and ADR-clause preservation._
