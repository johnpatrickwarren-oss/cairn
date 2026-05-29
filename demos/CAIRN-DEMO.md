# Cairn attribution walkthrough — DS-Cairn proof-of-life

_Companion to `tools/cairn.js`. Run via `node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json`._

This demo shows the Cairn (Addition #30) structured-RCA / postmortem
attribution end-to-end: an incident is described by its onset time +
affected signals; four candidate cause-events from four different audit
streams (DS, Tessera, Anvil, generic external) are scored against the
incident; Cairn produces a ranked attribution report with cited evidence.

The lifecycle frame: **DeploySignal catches before promotion. Tessera
observes during steady state. Cairn does the postmortem when something
escapes both — statistically, not by eyeballing dashboards.**

## The scenario

An LLM-inference service experiences a p99-latency + downstream-error
regression at incident onset `2026-05-19T22:00:00Z`. The on-call SRE
runs Cairn against the prior 4-hour candidate-event window:

| Candidate | Source | Lag before onset | Kind σ default | Evidence |
|---|---|---|---|---|
| Deploy `model-weights-v2026-05-19-001` | DS audit | 18 min | 30 min | DS verdict: `extend` (engine concerned), α 90% consumed |
| Tessera shard event on `shard-04` | Tessera VerdictGroup | 25 min | 15 min | rollback verdict |
| Anvil chaos experiment (`network_delay`) | Anvil ExpectedFailurePattern | 90 min | 5 min | scheduled run; recovered |
| K8s rolling restart (env change) | generic external event | 4 hr | 6 hr | infra-ops feed |

## Expected ranked output (canonical "deploy did it" narrative)

```
 1.  80.7%  deploy             2026-05-19T21:42:00Z
     evidence: ds-audit:model-weights-v2026-05-19-001@1747699320#v2026-05-19-mosaic
     breakdown: kernel=0.8353 × prior=0.35 × evidence_boost=1.50 = score 4.385e-1

 2.  14.7%  env_change         2026-05-19T18:00:00Z
     evidence: infra-ops:infra-cluster-rolling-restart-2026-05-19
     breakdown: kernel=0.8007 × prior=0.10 × evidence_boost=1.00 = score 8.007e-2

 3.   4.6%  shard_event        2026-05-19T21:35:00Z
     evidence: tessera-verdict-group:tessera-vg-2026-05-19-22-shard-04
     breakdown: kernel=0.2494 × prior=0.10 × evidence_boost=1.00 = score 2.494e-2

  Suppressed (mechanistically inconsistent):
  · [kernel_underflow] chaos_experiment: chaos:anvil-chaos-2026-05-19-3pm
```

## Reading the ranking

- **Deploy ranks first (80.7%)** because the timestamp alignment is good
  (18-minute lag well within the 30-minute deploy kernel σ; kernel value
  0.84); the per-kind prior is highest (deploys are the most common
  incident cause); and the DS `extend` verdict boosts the score 1.5×
  (engine was concerned even though it didn't roll back, providing
  positive evidence that this deploy is the load-bearing candidate).
- **Env change ranks second (14.7%)** because the 6-hour kernel σ for
  env changes makes the 4-hour lag still highly aligned (kernel value
  0.80), but the per-kind prior is low (0.10) and there's no engine-side
  evidence boost.
- **Shard event ranks third (4.6%)** — close in time (25 min), but the
  15-minute kernel σ makes the alignment moderate (0.25), and the
  per-kind prior is low.
- **Chaos experiment is mechanistically suppressed** with
  `kernel_underflow`: the chaos kernel σ is 5 minutes, and a 90-minute
  lag pushes the kernel value below the underflow threshold
  (1e-12). Cairn correctly excludes it from the posterior normalization
  rather than awarding a residual probability the operator would have
  to explain away.

## Honest scope at v1 (PRD-30 priorities)

Cairn does **alignment-based ranked attribution**, not Pearl-style causal
inference. The output describes which candidates are most consistent with
the incident's onset timing under the configured kernel + prior + evidence
model — it does not claim "this caused that." The postmortem narrative is
still the human's job; Cairn supplies the ranked candidates and cited
evidence the narrative cites.

What v1 ships:

- Typed contracts (`engine/cairn/types.ts`)
- Scoring algorithm (`engine/cairn/score.ts` — real math, not a stub)
- Audit-stream ingest helpers (`engine/cairn/ingest.ts`)
- CLI driver (`tools/cairn.js`)
- 26 tests (`test/q30-cairn-*.test.ts`)

What v1 does NOT ship (per PRD-30 anti-scope):

- Live PagerDuty/Opsgenie/incident.io webhook adapters (generic
  `candidatesFromExternalEvents` is the v1 surface; production-grade
  adapters are Slice 2, paired with first buyer conversation).
- Causal-inference framing (would invite Pearl-style scrutiny v1
  can't survive — honesty discipline).
- Multi-incident batch RCA, narrative auto-gen, web UI, streaming
  attribution.

## Reproducing this output

```bash
# Run against the fixtures
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json

# Get machine-readable JSON
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --json

# Regenerate the saved walkthrough JSON
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --json \
  > demos/cairn-attribution-walkthrough.json

# Verify the saved walkthrough is in sync (replay-clean invariant)
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json \
  --check demos/cairn-attribution-walkthrough.json
```

## Prior-sensitivity diagnostic (Q34)

`--prior-sensitivity` re-ranks the same candidates under *uniform* priors and asks: **is the #1 winning on timing evidence, or just on its prior?** A ranking that flips when priors are flattened is "prior-driven" and should be trusted less.

```bash
# Prior-DRIVEN case: the deploy wins only on its 0.35 prior; flatten the priors
# and a better-timed feature-flag rollout takes #1.
node tools/cairn.js demos/cairn-incident.json demos/cairn-prior-sensitivity-demo.json --prior-sensitivity
```

```
  Prior-sensitivity diagnostic:
    baseline #1: deploy:checkout-svc-v2026-05-19-007        (posterior 0.7373)
    uniform  #1: external:feature-flag-rollout-2026-05-19   (posterior 0.5549)
    prior_driven: true
    ⚠ top candidate's lead depends on the prior, not timing alone.
```

Contrast — the **robust** (non-flip) case, so the demo is not self-confirming. In the canonical `cairn-candidates.json` scenario the deploy is so well-timed it stays #1 even under uniform priors:

```bash
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --prior-sensitivity --json
# → prior_driven: false (baseline #1 == uniform #1 == deploy:model-weights-…)
```

It's a pure, read-only diagnostic (re-ranks via a fresh flattened-prior config; never mutates the scorer). See [`coordination/Q34-CAIRN-PRIOR-SENSITIVITY-SPEC.md`](../coordination/Q34-CAIRN-PRIOR-SENSITIVITY-SPEC.md).

## Attribution-summary line (Q35)

`--summary` prints the one-liner an SRE pastes at the top of a postmortem. It is a
**read-only presentation helper**: it reads `ranked[0]`, `ranked.length`, and
`suppressed.length` off the already-computed result — no new scoring, no new math.

### Well-attributed case — deploy is genuinely the best-aligned candidate

```bash
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --summary
# → Top: deploy:model-weights-v2026-05-19-001 at 80.7% (3 ranked, 1 suppressed)
```

The deploy ranks first because timing is good (18-min lag within 30-min kernel σ),
the per-kind prior is highest (deploys are the most common incident cause), and the
DS `extend` verdict boosts the score 1.5×. The summary line faithfully reflects this.

### The case the summary gets wrong (mandated honest-failure case)

```bash
node tools/cairn.js demos/cairn-incident.json demos/cairn-prior-sensitivity-demo.json --summary
# → Top: deploy:checkout-svc-v2026-05-19-007 at 73.7% (2 ranked, 0 suppressed)
```

**Operator reading — the honest limitation:** the headline confidently names the deploy
as the top cause, but this is the *prior-driven mis-attribution* from Q34. In this
fixture the feature-flag rollout (`external:feature-flag-rollout-2026-05-19`) is far
better-aligned (200s lag vs 1200s for the deploy), but the deploy wins anyway because
its kind prior (0.35) overwhelms the timing evidence. The summary line is
**presentation-only and has no notion of correctness** — it will faithfully print a
confident headline even when the ranking is wrong. Pair `--summary` with
`--prior-sensitivity` (which flags this exact case as `prior_driven: true`) before
trusting the headline in a postmortem.

```bash
# Expose the prior-driven mis-attribution:
node tools/cairn.js demos/cairn-incident.json demos/cairn-prior-sensitivity-demo.json \
  --summary --prior-sensitivity
```

### Using --summary with --json

`--summary` composes independently with `--json`: the envelope gains a top-level
`summary` object; the base report shape is unchanged.

```bash
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --json --summary
# → { ..., "summary": { "headline": "Top: deploy:model-weights-v2026-05-19-001 at 80.7% (3 ranked, 1 suppressed)", "top_cause_id": "deploy:model-weights-v2026-05-19-001", "top_posterior": 0.807..., "ranked_count": 3, "suppressed_count": 1 } }
```

## See also

- `coordination/PRD-30-cairn.md` — PRD with US/FR/NFR/AC/anti-scope
- `coordination/Q30-CAIRN-ATTRIBUTION-SPEC.md` — Architect spec
- `NORTH-STAR-ARCHITECTURE.md` Addition #30 — lifecycle-loop framing + contract block
- `engine/cairn/` — typed contracts + scoring + ingest helpers
- `coordination/PRD-29-anvil.md` + `NORTH-STAR-ARCHITECTURE.md` Addition #29 — Anvil, the sibling chaos-verdict layer Cairn ingests from
- [Tessera](https://github.com/johnpatrickwarren-oss/tessera) — sibling product (per-shard observation layer Cairn ingests from)
