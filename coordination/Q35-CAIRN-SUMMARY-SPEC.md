# Q35 — Cairn attribution-summary line spec

_From: Architect. To: Implementer (Anchor `anchor run --tier full`, R03)._
_Date: 2026-05-29._
_Foundation: [PRD-30-cairn.md](PRD-30-cairn.md) + [Q30-CAIRN-ATTRIBUTION-SPEC.md](Q30-CAIRN-ATTRIBUTION-SPEC.md) (shipped Cairn v1); sibling read-only diagnostics Q31 (confidence), Q33 (coverage), Q34 (prior-sensitivity)._
_Type: full implementation brief (inline ceremony)._
_Pinned SHA: `8277bcc8c4b5f08d2d72c0ae7d818084e075ea9d` (HEAD)._
_Framework: Anchor methodology (Architect role; T0 anchor; skills 01 pre-emit-grilling, 06 anti-scope-ledger, 08 six-practices)._

---

## Spec

A ranked Cairn attribution report is several lines per candidate plus a suppressed
block plus optional diagnostics. The on-call SRE writing the postmortem wants **one
line** to paste at the top: *which candidate ranked first, how confident, and how
much was ranked vs. suppressed.* Today they must read the whole report and
hand-compose that sentence.

Add an **attribution-summary line**: a pure, read-only function that takes an
already-computed `RankedAttribution` and returns a small struct whose `headline`
field is the one-liner, plus the four scalars the headline is built from (so a UI
or another tool can recompose it). It reads `ranked[0]`, `ranked.length`, and
`suppressed.length` off the result — **nothing else** — and computes no new scores.

This is a **presentation layer over the scorer's output**, not a scoring change. It
adds zero new math, no new detector, no change to `score.ts` / `rankCandidates` /
`scoreCandidate` output shape, and no change to the default CLI output. New
capability is surfaced behind an opt-in `tools/cairn.js --summary` flag.

Closes Q35 AC-1 through AC-5.

---

## Architectural mechanism

One new pure function, reading fields off an existing `RankedAttribution`:

1. **Top candidate.** `top := ranked.ranked[0] ?? null`. When present,
   `top_cause_id := top.candidate.cause_id` and `top_posterior := top.posterior`
   (already in `[0,1]`, already normalized by `rankCandidates`). When absent (empty
   ranked set), `top_cause_id := null` and `top_posterior := 0`.

2. **Counts.** `ranked_count := ranked.ranked.length`;
   `suppressed_count := ranked.suppressed.length`. Both read directly off the result
   object — no recomputation, no re-scoring.

3. **Headline.** Deterministic string assembly:
   - **Non-empty:** `Top: <cause_id> at <pct>% (<ranked_count> ranked, <suppressed_count> suppressed)`
     where `pct := (top_posterior * 100).toFixed(1)`.
     e.g. `Top: deploy:model-weights-v2026-05-19-001 at 80.7% (3 ranked, 1 suppressed)`.
   - **Empty:** `No candidates ranked (0 ranked, <suppressed_count> suppressed)`
     (contains the literal substring **"no candidates ranked"**, case-insensitive, per AC-3).

### Why the percentage formula is `(top_posterior * 100).toFixed(1)`

This is **byte-for-byte the same formula** the existing ASCII renderer already uses
for per-candidate percentages (`tools/cairn.js:124` — `(s.posterior * 100).toFixed(1)`).
Reusing it means the summary headline's `80.7%` is identical to the `80.7%` the full
report already prints for the same candidate — no second rounding convention drifts
into the codebase. `toFixed` is deterministic (no locale, no clock); replay-clean.

### Why the input is the whole `RankedAttribution`, not `(candidates, incident, config)`

AC-1 fixes the signature as `attributionSummary(ranked)`. The function is strictly a
**read over an already-ranked result** — it must never re-invoke the scorer, because
re-scoring would (a) duplicate work and (b) risk diverging from the exact `ranked[0]`
the operator is looking at. Taking the `RankedAttribution` directly makes the
read-only contract structural: there is no `candidates`/`config` in scope to mutate,
and no path to `rankCandidates` from inside the function. (Contrast Q33/Q34, which
*do* take `(candidates, incident, config)` because they re-rank under perturbed
inputs; Q35 deliberately does not.)

### Pluralization is intentionally omitted

The headline uses `<n> ranked` / `<m> suppressed` verbatim — no `1 ranked` →
`1 rank` adjustment. "ranked"/"suppressed" are participles, not count-nouns, so they
read correctly at any count (`1 ranked`, `3 ranked`). This keeps the string
assembly trivial and the AC-2 exemplar exact.

### Empty / all-suppressed handling (AC-3)

If `ranked.ranked` is `[]` — whether because no candidates were supplied or because
every candidate was suppressed — `ranked.ranked[0]` is `undefined`. The
`?? null` guard yields `top_cause_id === null`, `top_posterior === 0`, and the
"no candidates ranked" headline. `suppressed_count` still reflects the (possibly
non-zero) suppressed set, so an all-suppressed incident reads
`No candidates ranked (0 ranked, 4 suppressed)`. **No throw** on any input.

---

## Existing architectural surface (REVIEWER-ANCHOR — mandatory)

All snippets verbatim from pinned SHA `8277bcc8c4b5f08d2d72c0ae7d818084e075ea9d`, opened 2026-05-29 via this session's Read/Grep tool calls.

| Inherited file | Pinned SHA | Lines | Verbatim snippet | Why cited |
|---|---|---|---|---|
| `types.ts` | `8277bcc` | 93–108 | `export interface RankedAttribution {\n  ranked: ScoredCandidate[];\n  suppressed: SuppressedCandidate[];\n  incident: IncidentDefinition;\n  config_used: { ... };\n}` | The **input type** of `attributionSummary`. The function reads only `.ranked` and `.suppressed` off it. |
| `types.ts` | `8277bcc` | 74–84 | `export interface ScoredCandidate {\n  candidate: AttributionCandidate;\n  posterior: number;\n  raw_score: number;\n  kernel_value: number;\n  kind_prior: number;\n  evidence_boost: number;\n}` | `ranked.ranked[0]` is a `ScoredCandidate`; the summary reads `.candidate.cause_id` and `.posterior` (already normalized to `[0,1]`). |
| `types.ts` | `8277bcc` | 86–91 | `export interface SuppressedCandidate {\n  candidate: AttributionCandidate;\n  suppression_reason:\n    \| 'post_incident_timestamp'\n    \| 'kernel_underflow';\n}` | `suppressed_count := ranked.suppressed.length`; the element type confirms `suppressed` is a plain array whose `.length` is the count. |
| `types.ts` | `8277bcc` | 8–9 | `export interface AttributionCandidate {\n  cause_id: string;` | `top_cause_id` is `candidate.cause_id` (a `string`); confirms the headline field is a string, never undefined when a top exists. |
| `score.ts` | `8277bcc` | 142–146 | `export function rankCandidates(\n  candidates: AttributionCandidate[],\n  incident: IncidentDefinition,\n  config: CairnScoringConfig = {},\n): RankedAttribution {` | The producer of the `RankedAttribution` the summary consumes. **Not called** by the summary — cited to anchor the contract boundary (summary is downstream of this, read-only). |
| `score.ts` | `8277bcc` | 167–173 | `const total = scored.reduce((acc, s) => acc + s.raw_score, 0);\n  for (const s of scored) s.posterior = total > 0 ? s.raw_score / total : 0;\n\n  scored.sort((a, b) => {\n    if (b.posterior !== a.posterior) return b.posterior - a.posterior;\n    return a.candidate.timestamp_unix - b.candidate.timestamp_unix;` | Establishes that `ranked[0]` is the well-defined, deterministic top (posterior desc, timestamp asc) and `posterior ∈ [0,1]` — so `(top_posterior*100).toFixed(1)` is meaningful and replay-clean. |
| `score.ts` | `8277bcc` | 175–181 | `return {\n    ranked: scored,\n    suppressed,\n    incident,\n    config_used: cfg,\n  };` | Confirms `ranked` and `suppressed` are the two arrays the summary's counts read; both always present (possibly empty). |
| `index.ts` | `8277bcc` | 8–9 | `export { scoreCandidate, rankCandidates } from './score';\nexport type { ScoreBreakdown } from './score';` | Barrel pattern to mirror — add `attributionSummary` + `AttributionSummary` exports here so `require('../dist')` in the CLI resolves them. |
| `index.ts` | `8277bcc` | 20–21 | `export { coverageDiagnostic } from './coverage';\nexport type { CoverageDiagnostic } from './coverage';` | Exact precedent for a read-only diagnostic's barrel exports (value + type) to copy verbatim for `summary.ts`. |
| `coverage.ts` | `8277bcc` | 1–40 | `// engine/cairn/coverage.ts — Cairn candidate-coverage diagnostic (Q33).\n// ... Pure, read-only measurement layer over the scorer. ... Does NOT score, rank, or mutate scorer config/output.\n... export function coverageDiagnostic(\n  candidates: AttributionCandidate[],\n  incident: IncidentDefinition,\n  config: CairnScoringConfig = {},\n): CoverageDiagnostic {` | Sibling read-only diagnostic: the module-header + pure-function shape `summary.ts` mirrors (header comment, extensionless type-only imports, single exported pure function). |
| `tsconfig.json` | `8277bcc` | 23 | `"include": ["index.ts", "score.ts", "ingest.ts", "types.ts", "confidence.ts", "calibration.ts", "coverage.ts", "prior-sensitivity.ts"],` | Must gain `"summary.ts"` so `tsc` compiles it into `dist/`. |
| `tools/cairn.js` | `8277bcc` | 65–85 | `function buildReport(incident, candidatesSrc, withConfidence) {\n  const candidates = assembleCandidates(candidatesSrc);\n  const config = candidatesSrc.config ?? {};\n  const ranked = rankCandidates(candidates, incident, config);\n  const report = {\n    cairn_report_version: REPORT_VERSION,\n    incident,\n    ranked: ranked.ranked,\n    suppressed: ranked.suppressed,\n    config_used: ranked.config_used,\n  };` | The CLI already computes a `RankedAttribution` (`const ranked = ...`) but discards the object after spreading its fields. The summary needs the `RankedAttribution`; recompute it at the `--summary` output site (cheap, pure) — **do not** change `buildReport`'s returned `report` object. |
| `tools/cairn.js` | `8277bcc` | 117–118 | `if (report.ranked.length === 0) {\n      L.push('  (no candidates ranked — all candidates either absent or suppressed)');` | Existing "no candidates ranked" wording — the summary's empty headline aligns with this phrasing so operators see one consistent message. |
| `tools/cairn.js` | `8277bcc` | 124 | `const pct = (s.posterior * 100).toFixed(1).padStart(5);` | The **canonical percentage formula** to reuse so the headline's `80.7%` matches the per-row `80.7%` exactly (no rounding drift). |
| `tools/cairn.js` | `8277bcc` | 188–203 | `function main() {\n  const args = process.argv.slice(2);\n  ...\n  const jsonOut = args.includes('--json');\n  const priorSens = args.includes('--prior-sensitivity');\n  const checkIdx = args.indexOf('--check');\n  ... const coverageOut = args.includes('--coverage');\n  const withConfidence = args.includes('--confidence') && !checkPath;` | The flag-parse site to extend with `const summaryOut = args.includes('--summary');`, mirroring `coverageOut`/`priorSens`. |
| `tools/cairn.js` | `8277bcc` | 221–231 | `if (checkPath) {\n    const expected = JSON.parse(...);\n    const actual = JSON.parse(JSON.stringify(report));\n    const ok = JSON.stringify(actual) === JSON.stringify(expected);\n    ... return;\n  }` | The `--check` replay-fixture early-return. **Must stay above and unaffected** by `--summary` — `--summary` is ignored under `--check`, protecting the walkthrough fixture (additive-replay-clean). |
| `tools/cairn.js` | `8277bcc` | 233–253 | `if (jsonOut) {\n    ... process.stdout.write(JSON.stringify(report, null, 2) + '\\n');\n  } else {\n    console.log(renderAscii(report));\n    if (coverageOut) { console.log(renderCoverage(report.coverage)); }\n    if (priorSens) { ... console.log(renderPriorSensitivity(diag)); }\n  }` | The output site. `--summary` follows the exact `coverageOut`/`priorSens` pattern: gated JSON-key add and gated ASCII block; default (no flag) path emits unchanged bytes. |
| `ingest.ts` | `8277bcc` | 30 | `cause_id: \`deploy:${r.deploy_id}\`,` | Confirms `cause_id`s are namespaced (`deploy:<id>`, `external:<id>`, `chaos:<id>`, `tessera-shard:...`) — the headline prints `cause_id` verbatim, matching the AC-2 exemplar `deploy:X`. |

**Architect self-attest checklist (ticked at emit):**

- [x] Files opened at brief-drafting time via this session's Read/Grep calls.
- [x] Snippet citations verbatim from pinned SHA `8277bcc8c4b5f08d2d72c0ae7d818084e075ea9d` (current HEAD; `git status` clean — working tree == HEAD).
- [x] Line numbers verified against file content at the pinned SHA.
- [x] Verified the summary takes a `RankedAttribution` and reads only `.ranked` / `.suppressed` — it never calls `rankCandidates`/`scoreCandidate` and has no `candidates`/`config` in scope, so the read-only obligation is structural.

---

## Implementation surface

### File: `summary.ts` (new — repo root, sibling to `score.ts` / `coverage.ts`)

Extensionless TS imports per repo convention. Pure; no `Math.random`, no `Date.now`, no `new Date()`, no I/O.

```ts
// engine/cairn/summary.ts — Cairn attribution-summary line (Q35 / Addition #35).
//
// Pure, read-only PRESENTATION layer over a computed RankedAttribution. Produces
// the one-liner an SRE pastes at the top of a postmortem: which candidate ranked
// first, how confident, and how many were ranked vs. suppressed. Reads ranked[0],
// ranked.length, and suppressed.length off the result — computes NO new scores,
// calls neither rankCandidates nor scoreCandidate, mutates nothing.

import type { RankedAttribution } from './types';

/** One-line, human-readable summary of a ranked attribution. Field shape is
 *  frozen by Q35 AC-2; do not add/rename fields without a follow-on AC. */
export interface AttributionSummary {
  /** The paste-ready one-liner. Non-empty:
   *  `Top: <cause_id> at <pct>% (<n> ranked, <m> suppressed)`.
   *  Empty ranked set: `No candidates ranked (0 ranked, <m> suppressed)`. */
  headline: string;
  /** cause_id of ranked[0], or null when the ranked set is empty. */
  top_cause_id: string | null;
  /** posterior of ranked[0] (already in [0,1]); 0 when the ranked set is empty. */
  top_posterior: number;
  /** ranked.ranked.length. */
  ranked_count: number;
  /** ranked.suppressed.length (may be > 0 even when ranked_count === 0). */
  suppressed_count: number;
}

/** Build the attribution-summary line. Pure + deterministic: no RNG, no clock,
 *  no mutation. Read-only over the supplied RankedAttribution. */
export function attributionSummary(ranked: RankedAttribution): AttributionSummary {
  const ranked_count = ranked.ranked.length;
  const suppressed_count = ranked.suppressed.length;
  const top = ranked.ranked[0] ?? null;

  // AC-3: empty ranked set → null top, 0 posterior, "no candidates ranked", no throw.
  if (top === null) {
    return {
      headline: `No candidates ranked (0 ranked, ${suppressed_count} suppressed)`,
      top_cause_id: null,
      top_posterior: 0,
      ranked_count,
      suppressed_count,
    };
  }

  const top_cause_id = top.candidate.cause_id;
  const top_posterior = top.posterior;
  // Same formula as the per-row ASCII renderer (tools/cairn.js:124) — no drift.
  const pct = (top_posterior * 100).toFixed(1);

  return {
    headline:
      `Top: ${top_cause_id} at ${pct}% ` +
      `(${ranked_count} ranked, ${suppressed_count} suppressed)`,
    top_cause_id,
    top_posterior,
    ranked_count,
    suppressed_count,
  };
}
```

### File: `index.ts` (edit — additive, mirror existing barrel pattern)

Append alongside the other diagnostic exports (mirroring index.ts:20–21):

```ts
export { attributionSummary } from './summary';
export type { AttributionSummary } from './summary';
```

### File: `tsconfig.json` (edit — additive)

Add `"summary.ts"` to the `include` array (tsconfig.json:23):

```json
"include": ["index.ts", "score.ts", "ingest.ts", "types.ts", "confidence.ts", "calibration.ts", "coverage.ts", "prior-sensitivity.ts", "summary.ts"],
```

### File: `tools/cairn.js` (edit — strictly additive, opt-in flag only)

**Default output must stay byte-identical.** Rules:

1. Add `attributionSummary` to the destructured `require('../dist')` import (cairn.js:30–40), next to `coverageDiagnostic`.
2. Parse `const summaryOut = args.includes('--summary');` next to the existing `coverageOut`/`priorSens` parses (cairn.js:196–200). Add `--summary` to the usage string (cairn.js:191).
3. The `--check` branch (cairn.js:221–231) returns early and is **left exactly as-is** — `--summary` is ignored under `--check`, so the replay walkthrough fixture path is untouched (additive-replay-clean).
4. When `summaryOut` is **false**, both `--json` and ASCII paths emit exactly the bytes they emit today. No new keys, no new lines. (Tested.)
5. When `summaryOut` is **true**:
   - Recompute the `RankedAttribution` at the output site from the same inputs `buildReport` uses:
     `const rankedResult = rankCandidates(assembleCandidates(candidatesSrc), incident, candidatesSrc.config ?? {});`
     then `const summary = attributionSummary(rankedResult);`. **Do not** change what `buildReport`'s `report` object contains. (Recompute is pure + cheap; chosen over threading `ranked` out of `buildReport` to keep that function's contract frozen.)
   - `--json`: add a single top-level key `summary` to the emitted envelope, on the way out only, only under the flag. The base `report` object is unchanged.
   - ASCII: after `renderAscii(report)` (and after the existing coverage/prior-sensitivity blocks, ordering is implementer's choice but must not alter their output), `console.log(summary.headline)` — a single paste-ready line. No box-drawing required; the headline *is* the deliverable.
6. The summary uses only result-derived values — no `Date.now`, no `Math.random`, no `new Date(...)` (NFR-3). Numeric/string fields only; no timestamps in this block.

> Interaction note: `--summary` composes with `--json`, `--coverage`, and `--prior-sensitivity` independently (each is its own `args.includes` gate). Combining `--summary --prior-sensitivity --json` yields an envelope with both `summary` and `prior_sensitivity` keys; neither perturbs the other or the base report.

### File: `demos/CAIRN-DEMO.md` (edit — additive append)

Append an "Attribution-summary line (Q35)" section. It must show **two** cases so the
demo is **not self-confirming** (per `no-self-confirming-demo`):

1. **Canonical / well-attributed case** — the existing `cairn-candidates.json` scenario.
   Command + expected headline. This fixture produces exactly the AC-2 exemplar:

   ```bash
   node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --summary
   # → Top: deploy:model-weights-v2026-05-19-001 at 80.7% (3 ranked, 1 suppressed)
   ```

2. **The case the summary gets wrong (required honest-failure case)** — run `--summary`
   against the **prior-sensitivity demo fixture** `demos/cairn-prior-sensitivity-demo.json`
   (the known prior-driven mis-attribution from Q34, where the deploy ranks #1 on its
   prior, not on timing — the better-aligned candidate is the feature-flag rollout):

   ```bash
   node tools/cairn.js demos/cairn-incident.json demos/cairn-prior-sensitivity-demo.json --summary
   # → Top: deploy:checkout-svc-v2026-05-19-007 at 73.7% (2 ranked, 0 suppressed)
   ```

   **Operator reading (the honest limitation):** the one-liner confidently names the
   deploy as the top cause, but this is the *prior-driven mis-attribution* — the summary
   line is **presentation-only and has no notion of correctness**, so it will faithfully
   print a confident headline even for a case the ranking gets wrong. The summary is a
   convenience, not a verdict: pair it with `--prior-sensitivity` (which flags this exact
   case as `prior_driven: true`) before trusting the headline in a postmortem. This is the
   demo's mandated "case the system gets wrong" — surfaced honestly, not papered over.

---

## Tests

### `test/q35-cairn-summary.test.ts` (new — ≥ 4 tests, each mapped to an AC)

Build against `dist/` (`import { attributionSummary } from '../dist/summary'`, types
from `'../dist/types'`), `node --test`, mirroring `test/q33-cairn-coverage.test.ts`.
Use a fixed `T0` constant (no clock). Construct inputs by calling `rankCandidates`
(imported from `'../dist/score'`) on fixed candidates/incident so the test exercises a
real `RankedAttribution`, not a hand-mocked one.

1. **T1 / AC-1, AC-2 — module + shape.** `attributionSummary` is a function; on a
   non-empty ranked set it returns an object with exactly the five keys
   (`headline`, `top_cause_id`, `top_posterior`, `ranked_count`, `suppressed_count`)
   with correct types (`headline` string, `top_cause_id` `string | null`,
   `top_posterior`/`ranked_count`/`suppressed_count` numbers).
2. **T2 / AC-2 — headline format is exact.** Build a ranked set with a known top
   (deploy near onset) so `top_posterior` is known; assert the headline matches the
   precise template `Top: <cause_id> at <pct>% (<n> ranked, <m> suppressed)`, where
   `<pct>` equals `(top_posterior*100).toFixed(1)` and `<cause_id>` is the literal
   `ranked[0].candidate.cause_id`. Assert `top_cause_id`/`top_posterior` equal
   `ranked[0]`'s fields and `ranked_count`/`suppressed_count` equal the array lengths.
   Use the **canonical demo fixture numbers** so this test also pins the AC-2 exemplar
   `Top: deploy:... at 80.7% (3 ranked, 1 suppressed)`. Breaking the formula (wrong
   rounding, wrong order, missing parens) fails this assertion.
3. **T3 / AC-3 — empty ranked set.** `attributionSummary(rankCandidates([], incident))`
   does **not** throw; assert `top_cause_id === null`, `top_posterior === 0`,
   `ranked_count === 0`, and `headline.toLowerCase()` includes `'no candidates ranked'`.
   Add a sibling assertion for the **all-suppressed** case (every candidate
   post-incident → `ranked` empty but `suppressed_count > 0`): same null/0 top, and the
   headline reports the non-zero suppressed count
   (`No candidates ranked (0 ranked, N suppressed)` with `N === suppressed_count`).
   This proves `suppressed_count` is independent of `ranked_count` and that the empty
   path is reached via suppression, not only via empty input.
4. **T4 / AC-4 — pure + deterministic + read-only (no scorer mutation).** Two
   successive calls on the same `RankedAttribution` produce `deepEqual` results and
   byte-identical `JSON.stringify`. Deep-snapshot (JSON round-trip) the
   `RankedAttribution` before the call and `assert.deepEqual` it against the snapshot
   after — proving the summary does not mutate `ranked`, `ranked.ranked[0]`, or
   `ranked.suppressed`. (The "do not modify `score.ts`/`rankCandidates`" clause is
   structural — the function never imports or calls them — and is asserted indirectly
   by the unchanged-result-object snapshot.)
5. **T5 / AC-5 — CLI opt-in `--summary` + default-unchanged + `--check` intact.**
   - With `--summary` (ASCII): `execSync` the CLI on the canonical fixtures and assert
     stdout **contains** the exact headline line
     `Top: deploy:model-weights-v2026-05-19-001 at 80.7% (3 ranked, 1 suppressed)`.
   - With `--summary --json`: parsed JSON has a top-level `summary` object whose five
     fields match (`top_cause_id`, `top_posterior`, counts, `headline`).
   - **Default-output-unchanged guard:** capture
     `node tools/cairn.js <incident> <candidates> --json` (no flag) and assert it has
     **no** `summary` key and still carries `cairn_report_version: 'v1'`, `ranked`,
     `suppressed` (byte-identical-default invariant).
   - **Replay guard:** `--check demos/cairn-attribution-walkthrough.json` still passes
     with `--summary` present on the same line (flag ignored under `--check`).
6. **T6 / AC-2, AC-5 — the honest-failure demo case (not self-confirming).** Run the
   summary against the prior-sensitivity demo fixture and assert the headline
   confidently names the deploy (`Top: deploy:checkout-svc-v2026-05-19-007 at 73.7% ...`)
   — documenting in the test comment that this top is the *known prior-driven
   mis-attribution*, i.e. the summary line will print a confident headline for a case
   the ranking gets wrong (the summary has no notion of correctness by design).

> Note: tests 2 and 6 are the demo's well-attributed + mis-attributed pair, satisfying
> the "demo must include a case the system gets wrong" reinforcement — the
> prior-sensitivity fixture case *is* the wrong attribution the headline confidently
> states.

---

## Acceptance criteria (Q35)

| AC | Statement | Covered by |
|---|---|---|
| AC-1 | New module `summary.ts` exports `attributionSummary(ranked) => AttributionSummary`. | `summary.ts`; index.ts + tsconfig edits; Test 1 |
| AC-2 | `AttributionSummary` = `{ headline, top_cause_id (string\|null), top_posterior (number), ranked_count (number), suppressed_count (number) }`; `headline` reads like `Top: deploy:X at 80.7% (3 ranked, 1 suppressed)`. | `AttributionSummary` interface; headline assembly; Tests 1, 2, 6 |
| AC-3 | Empty ranked set → `top_cause_id` null, `top_posterior` 0, "no candidates ranked" headline, no throw. | `?? null` guard + empty branch; Test 3 |
| AC-4 | Pure + deterministic (no RNG, no clock); strictly additive (no change to `score.ts`/`rankCandidates`/default CLI output); read-only over the ranked result. | Whole design (structural read-only); Test 4 |
| AC-5 | Opt-in `tools/cairn.js --summary` (default output unchanged); ≥ 4 tests in `test/q35-cairn-summary.test.ts` each mapping to an AC; demo line in `demos/CAIRN-DEMO.md`. | CLI flag; Tests 1–6; CAIRN-DEMO.md append |

---

## Anti-scope

Per [`skills/06-anti-scope-ledger.md`] and the PRD-30 anti-scope ledger. **NOT in scope for Q35:**

- **NO change to the scorer's math or output shape.** `score.ts`, `scoreCandidate`, `rankCandidates`, `ScoreBreakdown`, `ScoredCandidate`, `RankedAttribution` are read, never edited. The summary adds zero terms to `s(c) = K × π × e` and computes no new numbers beyond a `*100` + `toFixed(1)` reformat of an existing posterior.
- **NO change to the default CLI output.** `--summary` is strictly opt-in; without it `tools/cairn.js` emits byte-identical bytes (tested). The `--check` replay walkthrough fixture path is untouched and takes precedence over the flag.
- **NO re-scoring or re-ranking inside the summary.** The function consumes an existing `RankedAttribution` and never calls `rankCandidates`/`scoreCandidate`. (The CLI recomputes the `RankedAttribution` only to *supply* the input; the function itself is purely a read.)
- **NO causal-inference framing** (PRD-30 AS-3). The headline reports the top *ranked* candidate ("Top:"), never "root cause" / "caused by" / counterfactual language.
- **NO new detector family / no `engine/detectors/*` touch** (Q2.B.6.4 ADR). Pure presentation layer over the scorer's result.
- **NO live telemetry / no new ingestion adapters** (PRD-30 AS-1, NFR-5). Reuses existing fixtures + ingest helpers only.
- **NO mutation of the ranked result, its candidates, or config** (read-only diagnostic discipline / `measurement-not-mutation`). The function only reads fields.
- **NO new `CandidateKind`, no new `CairnScoringConfig` field, no schema bump, no change to the persisted report shape.** `AttributionSummary` is a new return type, not a change to `RankedAttribution` or the CLI report envelope.
- **NO confidence/decisiveness/robustness/coverage/prior-sensitivity logic re-implemented here.** The summary reports *what ranked first and by how much*, not *how trustworthy it is* — trustworthiness lives in the existing `--confidence` / `--prior-sensitivity` / `--coverage` diagnostics. The summary deliberately does not editorialize.
- **NO multi-line narrative, no per-candidate breakdown, no localization/i18n, no number-word pluralization, no multi-incident batch, no web UI, no streaming** (PRD-30 AS-4/AS-6/AS-7). One line, one incident, CLI + library surface.
- **NO change to `tessera`/`anvil`/DS wire contracts.**

**Cross-references preserved:** Q2.B.6.4 ADR clauses 1–5; Q30 ADR (consumes Q30 scorer unchanged); Q31/Q33/Q34 read-only-diagnostic precedent; Q60 V2 clause 3 (no live customer telemetry); enterprise-infrastructure boundary; no-skip policy.

---

## Pre-emit grilling pass (skill 01)

### CRITICAL (would fail an AC or break an invariant if wrong)

- **C1 — Empty / all-suppressed must not throw (AC-3).** `ranked.ranked[0]` on `[]` is `undefined`; an unguarded `.candidate.cause_id` would throw. **Resolution:** `ranked.ranked[0] ?? null` and an explicit empty branch returning `null`/`0`/"no candidates ranked". Test 3 covers empty input *and* all-suppressed (empty `ranked` with non-zero `suppressed`).
- **C2 — Default CLI output must stay byte-identical (AC-4/AC-5, replay-clean).** Adding a `summary` key unconditionally, or printing the headline unconditionally, would break the `--check` walkthrough fixture and every downstream byte-compare. **Resolution:** flag-gated emission (`summaryOut`); `--check` early-return left verbatim and takes precedence; Test 5 asserts no-flag `--json` output lacks the `summary` key and `--check` still passes with `--summary` present.
- **C3 — Read-only over the ranked result (AC-4).** The function must not mutate `ranked`/`ranked.ranked[0]`/`ranked.suppressed`. **Resolution:** the body only reads fields and builds a fresh return object; there is no assignment into any input. Test 4 snapshots the `RankedAttribution` before/after and `deepEqual`s. The "no change to `score.ts`/`rankCandidates`" clause is structural — `summary.ts` imports only the `RankedAttribution` *type*, never the scorer functions.
- **C4 — Headline matches the AC-2 exemplar exactly.** AC-2 fixes the shape `Top: deploy:X at 80.7% (3 ranked, 1 suppressed)`. A wrong separator, missing `%`, wrong rounding, or pluralized noun would fail. **Resolution:** the exact template is specified; percentage uses the same `(p*100).toFixed(1)` as the existing renderer (cairn.js:124); the canonical fixture *produces* the exemplar literally, and Test 2 pins it.

### LIKELY-SURFACES (a reviewer will probe these)

- **L1 — "Why recompute `rankCandidates` in the CLI instead of reusing `buildReport`'s result?"** `buildReport` spreads the `RankedAttribution` into a flat `report` object and discards the typed object; `attributionSummary` needs the `RankedAttribution`. Recompute is pure, deterministic, and cheap (the scorer is O(n)); it keeps `buildReport`'s returned shape frozen (byte-identical default output). Threading the object out of `buildReport` is the alternative and is explicitly rejected to avoid touching that function's contract. Documented in the CLI edit rules + the cairn.js:65–85 citation.
- **L2 — "Is `top_posterior` already normalized, or does the summary normalize?"** Already normalized by `rankCandidates` (score.ts:167–168: `posterior = raw_score / total`), so `top_posterior ∈ [0,1]` and `*100` is a true percentage. The summary does no normalization. Documented + cited.
- **L3 — "Could the headline percentage drift from the per-row percentage in the full report?"** No — both use the identical `(posterior*100).toFixed(1)` formula (cairn.js:124 is the cited source of truth). Documented as the reason for the formula choice.
- **L4 — "What if two candidates tie and the deterministic tiebreak picks a different `ranked[0]` than the operator expects?"** `ranked[0]` is fully determined by the scorer's `(posterior desc, timestamp asc)` sort (score.ts:170–173). The summary faithfully reports whatever `ranked[0]` is; it introduces no new tiebreak. Replay-clean. Documented.
- **L5 — "Does `suppressed_count` mislead when `ranked_count === 0` but suppressions exist?"** No — the empty headline explicitly prints both counts (`No candidates ranked (0 ranked, N suppressed)`), so an all-suppressed incident is legible, not silently empty. Test 3 asserts the non-zero `N`.

### PRE-EMPTABLE (head off before review)

- **P1 — Tempting shortcut: fold the summary into `rankCandidates`'s return value.** Rejected — changes `RankedAttribution`'s shape, violating AC-4 ("do not modify `rankCandidates` output") and the replay-clean fixture. The summary is a separate downstream read.
- **P2 — Self-confirming demo.** Forbidden by reinforcement. The demo ships **both** the well-attributed canonical case (deploy genuinely best-aligned) **and** the prior-sensitivity mis-attribution fixture, where the headline confidently names a top that the ranking gets *wrong* (prior-driven). The mis-attribution case is the mandated "case the system gets wrong" — the summary, being presentation-only, faithfully prints the misleading line, and the demo says so and points to `--prior-sensitivity`.
- **P3 — Clock/RNG leak.** The function uses none (`toFixed` + string concat only). The CLI `--summary` block must avoid `new Date(...)` entirely (no timestamps in the headline) — even though `renderAscii` elsewhere uses `new Date(ts*1000).toISOString()` (deterministic from input, still replay-clean). Documented in the CLI edit rules.
- **P4 — Build/registration drift.** Forgetting `tsconfig.json` `include` or the `index.ts` barrel export would leave the CLI's `require('../dist')` unable to resolve `attributionSummary`. Both edits are called out explicitly and are part of AC-1's coverage.
- **P5 — Pluralization request creep.** A reviewer may ask for `1 candidate ranked` grammar. Out of scope (anti-scope) and unnecessary: "ranked"/"suppressed" read correctly at any count, and AC-2's exemplar uses the bare-count form. Documented in anti-scope.
- **P6 — `top_posterior` precision vs. the headline `pct`.** `top_posterior` is the **raw** float (full precision, for programmatic consumers); `pct` is the **display** rounding (`toFixed(1)`). They are intentionally different representations of the same value — `top_posterior !== Number(pct)/100` in general. Documented in the interface comments so a consumer does not assume the headline's rounded value equals the struct field.

---

## Implementation timeline (Implementer)

- ~10 min: `summary.ts` (the function — trivial read + string assembly).
- ~5 min: `index.ts` barrel export + `tsconfig.json` include.
- ~15 min: `tools/cairn.js` `--summary` flag (additive, gated) + recompute `RankedAttribution` at the output site.
- ~10 min: `demos/CAIRN-DEMO.md` append (both the well-attributed + mis-attributed cases).
- ~25 min: `test/q35-cairn-summary.test.ts` (6 tests).
- ~5 min: full build + `node --test`; confirm pre-existing suite count unchanged + 6 new pass; confirm default CLI output byte-identical and `--check` still green.

---

_Spec authored under Anchor methodology: Q-NN-SPEC-TEMPLATE + `08-architect-six-practices` + `03-four-anchor-defense` (T0 anchor) + `01-pre-emit-grilling` + `06-anti-scope-ledger`. Cross-references PRD-30 + Q30-CAIRN-ATTRIBUTION-SPEC for traceability. Read-only presentation layer; strictly additive; replay-clean._
