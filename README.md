# Cairn

**Structured RCA / postmortem attribution.** When a regression escapes deploy-gate and steady-state observation and lands in prod, Cairn ranks candidate cause-events against the incident's onset under a probabilistic alignment model — *statistically, not by eyeballing dashboards*.

The lifecycle frame:

> **DeploySignal catches before promotion. Tessera observes during steady state. Cairn attributes when something escapes both.**

Strong Verica/Casey adjacency: chaos engineering finds weaknesses *before* they cause incidents; Cairn ranks them *after*. Two halves of the same methodology.

## What Cairn is

Cairn is a sibling product to [DeploySignal](https://github.com/johnpatrickwarren-oss/deploysignal), [Tessera](https://github.com/johnpatrickwarren-oss/tessera), and the chaos-verdict layer Anvil (which ships inside DS). It consumes audit streams from the rest of the bundle:

| Source | What Cairn reads | Source-side product |
|---|---|---|
| DS audit JSONL | per-deploy verdict + α-budget consumption + per-cell baseline ref | [`deploysignal`](https://github.com/johnpatrickwarren-oss/deploysignal) |
| Tessera VerdictGroup feed | per-shard observations + freeze-hook events | [`tessera`](https://github.com/johnpatrickwarren-oss/tessera) |
| Anvil ExpectedFailurePattern | chaos-experiment definitions + fault windows | DS-internal (`engine/o0/anvil/`) |
| Generic external events | incident-mgmt webhook payloads, env-change feeds | operator-supplied JSON |

Given an `IncidentDefinition` (onset time + affected signals + optional engine-inferred onset distribution) and a set of candidates from those sources, Cairn ranks them by a Bayesian alignment score:

```
s(c) = K(Δt, σ_kind) × π(kind) × e(c)
posterior(c) = s(c) / Σ s(c')
```

| Component | What it captures |
|---|---|
| `K(Δt, σ_kind)` | Gaussian timestamp-alignment kernel; per-cause-kind bandwidth (deploys ~30 min; chaos ~5 min; dependency ~2 hr; env ~6 hr; shard ~15 min; generic ~1 hr) |
| `π(kind)` | per-kind prior (operator's base-rate belief that this kind is the typical cause) |
| `e(c)` | evidence-quality boost: a DS `proceed` verdict on a candidate down-weights to 0.5 (negative evidence — engine emitted clean); `extend` up-weights to 1.5; `rollback` overridden by operator up-weights to 2.0 |

Mechanistic-inconsistency suppression: candidates with `timestamp > onset + grace` are excluded from the posterior with `suppression_reason: 'post_incident_timestamp'`. Engine-inferred onset preference: when an `engine_onset_estimate` is supplied (e.g., from a DS audit record's Page-CUSUM fire-tick + confidence band), it supersedes the operator-supplied point onset; kernel σ combines engine uncertainty + per-kind kernel via quadrature.

## What Cairn does NOT do

Honesty discipline (load-bearing for the pitch):

- **Cairn does ranked alignment-based attribution, not causal inference.** The output language is "ranked attribution of timing-consistent candidates," never "root cause." Pearl-style counterfactuals require a known causal graph; Cairn ranks correlation-of-timing under a known set of candidates. Mislabeling the output as "causal" would be honesty-breach in the pitch.
- **Cairn does not author the postmortem narrative.** The output is structured ranked data + cited evidence; the narrative is still the human's job.
- **Cairn is one-incident-at-a-time at v1.** Multi-incident batch RCA + cross-incident pattern detection are future work.
- **Cairn does not consume live customer telemetry at v1.** Ships against synthetic fixtures + audit JSONL produced by existing DS / Tessera / Anvil demos.

## Getting started

Requires Node ≥ 20.

```bash
git clone https://github.com/johnpatrickwarren-oss/cairn.git
cd cairn
npm install
npm test
npm run build
```

## Quick demo (canonical "deploy did it" attribution)

```bash
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json
```

Output: ranked attribution report — deploy at 80.7% (with cited DS `extend`-verdict evidence), env_change at 14.7%, shard event at 4.6%, chaos experiment suppressed for kernel-underflow (90-min lag vs 5-min σ).

```bash
# Machine-readable
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --json

# Replay-clean verification
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json \
  --check demos/cairn-attribution-walkthrough.json
```

See [`demos/CAIRN-DEMO.md`](demos/CAIRN-DEMO.md) for the minute-by-minute walkthrough.

### Confidence & robustness (`--confidence`)

A bare posterior ("deploy 80.7%") doesn't say how much to trust the ranking. The opt-in `--confidence` flag adds two honesty signals without changing the default output:

```bash
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --confidence
```

- **Decisiveness** — the #1↔#2 posterior margin + the distribution's normalized entropy, summarized as a one-word label (`decisive` / `contested` / `ambiguous`). A 34%-vs-31% top is a coin-flip the postmortem shouldn't assert as "the cause."
- **Robustness** — re-ranks under a deterministic grid of onset perturbations (σ from the engine-inferred onset band when present, else 5 min) and reports whether the top candidate survives. If a ±σ onset shift flips the winner, the ranking is fragile and Cairn says so — and lists which shift dethrones it.

Both are computed by pure, deterministic functions (`decisiveness` / `robustness` in `confidence.ts`) — no RNG, so the output stays replay-clean. They are **additive**: the default report (and the `--check` replay fixture) is byte-identical to v1. See [`coordination/Q31-CAIRN-CONFIDENCE-SPEC.md`](coordination/Q31-CAIRN-CONFIDENCE-SPEC.md).

## Layout

```
cairn/
├── README.md                 # This file
├── LICENSE                   # Apache 2.0
├── NOTICE
├── package.json
├── tsconfig.json + tsconfig.test.json
├── types.ts                  # AttributionCandidate, IncidentDefinition,
│                             # CairnScoringConfig, RankedAttribution, …
├── score.ts                  # Bayesian alignment scoring (load-bearing math)
├── ingest.ts                 # 4 helpers consuming DS / Tessera / Anvil /
│                             # generic external-event wire shapes
├── index.ts                  # module barrel
├── tools/
│   └── cairn.js              # CLI driver (ASCII + --json + --check)
├── test/                     # 26 tests — score (14), ingest (5), CLI (4) + types
├── demos/
│   ├── CAIRN-DEMO.md         # walkthrough doc
│   ├── cairn-incident.json   # synthetic incident definition
│   ├── cairn-candidates.json # 4 candidate cause-events from 4 sources
│   └── cairn-attribution-walkthrough.json  # saved expected output (replay-clean)
└── coordination/
    ├── PRD-30-cairn.md       # Product requirements
    └── Q30-CAIRN-ATTRIBUTION-SPEC.md  # Architect specification
```

## Methodology

Cairn was developed using the [Anchor](https://github.com/johnpatrickwarren-oss/anchor) coordination methodology — five-role framework (PM / Architect / TPM / Implementer / Reviewer) with four-anchor pre-merge defense (T0 / T1 / T2 / T3), audit-tier round scaling, anti-scope-ledger discipline, and Memorial F sub-rule application.

The PRD + architect spec at `coordination/` capture the discipline application at brief-drafting time. Originally landed in the DeploySignal repo at `engine/cairn/*` (DS PR #21, merged 2026-05-21); extracted to this sibling repo for architectural consistency with the rest of the bundle (DS engine + Tessera + Cairn — three sibling products, one shared statistical substrate).

## License

Apache 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Status

**v1 publication candidate.** All PRD-30 AC-1 through AC-10 closed; 26 tests passing; type-check clean; demo replay-clean. Buyer-paired follow-ons (incident-mgmt webhook adapters, profile-level kernel defaults, multi-incident batch RCA, web UI, streaming) deferred per PRD-30 anti-scope.

## Contact

John Warren · john.patrick.warren@gmail.com
