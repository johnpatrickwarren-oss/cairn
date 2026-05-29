# Cairn coverage diagnostic — walkthrough (Q33)

The `--coverage` flag answers a question the ranked attribution can't: **was the candidate set even wide enough to contain the true cause?** A confident ranking over a too-narrow window is a silent under-attribution — a slow-burn cause earlier than the lookback gets its kernel underflowed and is dropped from the ranking with no signal. This is the exact blind spot the calibration harness (`tools/cairn-calibrate.js`) surfaced.

`coverageDiagnostic` is pure and read-only: it never scores, ranks, or mutates the scorer config. It resolves the per-kind kernel σ from the scorer's own `config_used` echo (so the defaults can't drift), then checks whether the earliest candidate leads onset by at least **2× the widest σ among the cause-kinds present**.

## The canonical demo is itself a warning case

Run `--coverage` against the standard fixture:

```bash
node tools/cairn.js demos/cairn-incident.json demos/cairn-candidates.json --coverage
```

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Cairn coverage diagnostic (--coverage)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  candidate_count:        4
  earliest_lead_seconds:  14400
  widest_sigma_seconds:   21600
  adequately_covered:     false

  ⚠  WARNING: candidate window may be too narrow: earliest candidate leads onset
  by 14400s, below 2× the widest configured kernel σ (21600s) among present
  cause-kinds. A slow-burn cause earlier than the lookback could be silently
  under-attributed (kernel-underflow suppression). Widen the candidate lookback
  to at least 43200s before onset.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

This is deliberate (per the "a demo must include a case the system gets wrong" discipline): the canonical attribution ranks the deploy at 80.7% with confidence, yet the coverage diagnostic flags that the candidate set only reaches **14,400 s (4 h)** before onset — while an `env_change` cause has a **6 h (21,600 s) kernel**, so anything earlier than the lookback would be invisible. The headline ranking and the coverage warning are *both* true: trust the ranking only as far as the window justifies.

## The contrast: an adequately-covered run

Coverage is relative to the configured bandwidths. If the operator's stack manifests env changes faster — say a 1 h `env_change` kernel — the same 4 h window is now ample. With `config.kernel_sigma_seconds.env_change = 3600`:

```
  candidate_count:        4
  earliest_lead_seconds:  14400
  widest_sigma_seconds:   3600
  adequately_covered:     true
  coverage adequate.
```

`2 × 3600 = 7200 s ≤ 14400 s`, so the window comfortably covers the widest kernel and no warning fires. (Widening the candidate lookback to include an earlier event has the same effect.)

## Shape

`coverageDiagnostic(candidates, incident, config?)` returns:

| field | meaning |
|---|---|
| `candidate_count` | number of candidates supplied |
| `earliest_lead_seconds` | `onset − min(candidate.timestamp)`; `null` if no candidates |
| `widest_sigma_seconds` | largest resolved σ among the present cause-kinds; `null` if none |
| `adequately_covered` | `count > 0 && earliest_lead ≥ 2 × widest_sigma` |
| `warning` | explanation when coverage is inadequate; `null` otherwise |

See [`coordination/Q33-CAIRN-COVERAGE-SPEC.md`](../coordination/Q33-CAIRN-COVERAGE-SPEC.md).
