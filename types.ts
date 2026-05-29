// engine/cairn/types.ts — Cairn (Addition #30 / PRD-30 / Q30) typed contracts.
//
// Structured RCA / postmortem attribution layer of the DS bundle. Closes
// the lifecycle loop: DS catches at gate-time, Tessera observes during
// steady state, Cairn attributes when a regression escapes both.

/** A single cause-event candidate that Cairn considers. */
export interface AttributionCandidate {
  cause_id: string;
  cause_kind: CandidateKind;
  /** Unix-seconds when the cause-event happened. */
  timestamp_unix: number;
  /** Provenance — pointer back to the source audit record / experiment /
   *  webhook payload. Replay/postmortem trace artifact. */
  evidence_ref: string;
  /** Optional metadata that ingest helpers populate when available. */
  metadata?: CandidateMetadata;
}

export type CandidateKind =
  | 'deploy'              // DS audit record
  | 'chaos_experiment'    // Anvil ExpectedFailurePattern
  | 'dependency_change'   // generic external event
  | 'env_change'          // generic external event (config rollout, infra)
  | 'shard_event'         // Tessera per-shard observation
  | 'generic';            // catch-all for external webhooks

export interface CandidateMetadata {
  /** When the candidate came from a DS audit record, the engine's verdict
   *  drives the evidence-quality boost (Q30.3 architect-pick). */
  ds_verdict?: 'proceed' | 'extend' | 'rollback' | 'baking';
  /** When DS evaluated the candidate, fraction of the deploy's α budget
   *  the engine consumed. Used in negative-evidence sharpening. */
  ds_alpha_consumed_ratio?: number;
  /** Anvil-only: pattern.kind of the chaos experiment. */
  expected_failure_kind?: string;
  /** Free-form passthrough — Tessera VerdictGroupId, incident-mgmt
   *  payload, descriptions, source identifiers, etc. */
  extra?: Record<string, unknown>;
}

/** Operator's description of the incident under attribution. */
export interface IncidentDefinition {
  incident_id: string;
  /** Best-known onset time (incident-mgmt alert ts, oncall report). */
  onset_time_unix: number;
  /** Signal(s) that exhibited the regression. */
  affected_signals: string[];
  regression_magnitude_unit?: 'relative_fraction' | 'absolute' | 'sigma';
  regression_magnitude?: number;
  /** Optional engine-inferred onset distribution (DS audit record's
   *  Page-CUSUM fire-tick + confidence band, or BOCPD run-length
   *  posterior). When present, supersedes onset_time_unix for kernel
   *  evaluation per Q30.1 architect-pick. */
  engine_onset_estimate?: {
    center_unix: number;
    sigma_seconds: number;
  };
}

export interface CairnScoringConfig {
  /** Gaussian-kernel bandwidth per cause-kind, in seconds. Per Q30.2. */
  kernel_sigma_seconds?: Partial<Record<CandidateKind, number>>;
  /** Per-kind prior. */
  kind_prior?: Partial<Record<CandidateKind, number>>;
  /** Grace window post-incident; candidates with timestamp in
   *  [onset, onset + grace_seconds] are still considered (clock skew,
   *  delayed event-recording). Default 60 seconds. */
  grace_seconds?: number;
  /** Operator-tunable evidence-quality boost (Q30.3). */
  evidence_boost?: Partial<Record<'proceed' | 'extend' | 'rollback' | 'baking', number>>;
}

export interface ScoredCandidate {
  candidate: AttributionCandidate;
  /** Normalized posterior (sums to 1.0 across the ranked set). */
  posterior: number;
  /** Raw unnormalized score (kernel × prior × evidence). */
  raw_score: number;
  /** Per-component breakdown for audit + UI. */
  kernel_value: number;
  kind_prior: number;
  evidence_boost: number;
}

export interface SuppressedCandidate {
  candidate: AttributionCandidate;
  suppression_reason:
    | 'post_incident_timestamp'   // timestamp after onset + grace
    | 'kernel_underflow';         // kernel value below numerical threshold
}

export interface RankedAttribution {
  /** Sorted by posterior descending; ties broken by timestamp ascending
   *  for replay determinism. */
  ranked: ScoredCandidate[];
  /** Excluded from posterior normalization. */
  suppressed: SuppressedCandidate[];
  /** Echo of the incident under attribution. */
  incident: IncidentDefinition;
  /** Echo of the effective config (defaults filled in). */
  config_used: {
    kernel_sigma_seconds: Record<CandidateKind, number>;
    kind_prior: Record<CandidateKind, number>;
    grace_seconds: number;
    evidence_boost: Record<'proceed' | 'extend' | 'rollback' | 'baking', number>;
  };
}

// ── Q31 — attribution confidence & robustness (additive layer) ──────────────
//
// These types describe a read-layer atop the v1 scorer. They are NOT folded
// into RankedAttribution (which stays byte-identical for replay-clean / the
// --check walkthrough fixture per Q31 back-compat anchor). Computed by the
// pure functions in confidence.ts and surfaced only behind `--confidence`.

/** Operator-tunable margin thresholds for the decisiveness label. */
export interface DecisivenessThresholds {
  /** top_margin ≥ this ⇒ 'decisive'. Default 0.5. */
  decisive?: number;
  /** top_margin ≥ this (and < decisive) ⇒ 'contested'. Default 0.15. */
  contested?: number;
}

/** How clear-cut the top ranking is, read off the posterior distribution. */
export interface Decisiveness {
  /** Posterior gap between #1 and #2 (1.0 if a single candidate; 0 if none). */
  top_margin: number;
  /** Shannon entropy of the posterior distribution, in bits. */
  entropy_bits: number;
  /** entropy_bits / log2(n), in [0,1]; 0 = one candidate holds all mass,
   *  1 = uniform over the ranked set. */
  entropy_normalized: number;
  label: 'no_candidates' | 'decisive' | 'contested' | 'ambiguous';
  /** Echo of the thresholds applied (defaults filled in). */
  thresholds_used: { decisive: number; contested: number };
}

export interface RobustnessOptions {
  /** Onset jitter σ in seconds. Falls back to
   *  engine_onset_estimate.sigma_seconds, then to 300 (5 min). */
  onset_sigma_seconds?: number;
  /** σ-multiples to probe. Default [-2,-1,-0.5,0.5,1,2]. Deterministic — no
   *  RNG, so robustness output is replay-clean (NFR-3). */
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
  /** Fraction of perturbation trials whose top candidate matched baseline. */
  top_stability: number;
  trials: RobustnessTrial[];
  flips: RobustnessTrial[];
}
