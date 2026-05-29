// confidence.ts — Cairn attribution confidence & robustness (Q31).
//
// Additive read-layer over the v1 scorer. Two pure, deterministic functions:
//
//   decisiveness(ranked)            — how clear-cut is the top ranking?
//                                     (posterior margin + entropy + label)
//   robustness(cands, incident, …)  — does the #1 survive onset perturbation?
//                                     (deterministic σ-grid re-rank; no RNG)
//
// Neither mutates RankedAttribution nor the caller's incident. No I/O, no RNG
// (replay-clean / NFR-3 preserved). See coordination/Q31-CAIRN-CONFIDENCE-SPEC.md.

import type {
  AttributionCandidate, IncidentDefinition, CairnScoringConfig, RankedAttribution,
  Decisiveness, DecisivenessThresholds, RobustnessOptions, RobustnessReport,
  RobustnessTrial,
} from './types';
import { rankCandidates } from './score';

export const DEFAULT_DECISIVE_MARGIN = 0.5;
export const DEFAULT_CONTESTED_MARGIN = 0.15;
export const DEFAULT_ONSET_JITTER_SECONDS = 300; // 5 minutes
export const DEFAULT_SIGMA_MULTIPLIERS: readonly number[] = [-2, -1, -0.5, 0.5, 1, 2];

/** Read off how decisive the top ranking is, directly from the (already
 *  sorted, posterior-descending) ranked set. No re-ranking. */
export function decisiveness(
  ranked: RankedAttribution,
  thresholds: DecisivenessThresholds = {},
): Decisiveness {
  const decisive = thresholds.decisive ?? DEFAULT_DECISIVE_MARGIN;
  const contested = thresholds.contested ?? DEFAULT_CONTESTED_MARGIN;
  const thresholds_used = { decisive, contested };

  const ps = ranked.ranked.map((s) => s.posterior);
  const n = ps.length;

  if (n === 0) {
    return { top_margin: 0, entropy_bits: 0, entropy_normalized: 0, label: 'no_candidates', thresholds_used };
  }

  const top_margin = n >= 2 ? ps[0] - ps[1] : 1;

  // Entropy over positive posteriors only — 0·log2(0) is defined as 0, but
  // Math.log2(0) = -Infinity so it must be filtered (Q31 grilling: LIKELY-SURFACES).
  const entropy_bits = -ps
    .filter((p) => p > 0)
    .reduce((acc, p) => acc + p * Math.log2(p), 0);
  const entropy_normalized = n >= 2 ? entropy_bits / Math.log2(n) : 0;

  let label: Decisiveness['label'];
  if (top_margin >= decisive) label = 'decisive';
  else if (top_margin >= contested) label = 'contested';
  else label = 'ambiguous';

  return { top_margin, entropy_bits, entropy_normalized, label, thresholds_used };
}

/** Build a perturbed copy of the incident with onset shifted by offset
 *  seconds. Never mutates the caller's object (incl. the nested estimate). */
function shiftOnset(incident: IncidentDefinition, offsetSeconds: number): IncidentDefinition {
  const shifted: IncidentDefinition = {
    ...incident,
    onset_time_unix: incident.onset_time_unix + offsetSeconds,
  };
  // engine_onset_estimate supersedes onset_time_unix for the kernel (Q30.1),
  // so it must move by the same offset to actually perturb the alignment.
  if (incident.engine_onset_estimate) {
    shifted.engine_onset_estimate = {
      ...incident.engine_onset_estimate,
      center_unix: incident.engine_onset_estimate.center_unix + offsetSeconds,
    };
  }
  return shifted;
}

/** Re-rank under a deterministic grid of onset perturbations and report
 *  whether the top candidate holds. */
export function robustness(
  candidates: AttributionCandidate[],
  incident: IncidentDefinition,
  config: CairnScoringConfig = {},
  opts: RobustnessOptions = {},
): RobustnessReport {
  const sigma =
    opts.onset_sigma_seconds ??
    incident.engine_onset_estimate?.sigma_seconds ??
    DEFAULT_ONSET_JITTER_SECONDS;
  const multipliers = opts.sigma_multipliers ?? [...DEFAULT_SIGMA_MULTIPLIERS];

  const baseline = rankCandidates(candidates, incident, config);
  const baseline_top_cause_id = baseline.ranked[0]?.candidate.cause_id ?? null;

  const trials: RobustnessTrial[] = multipliers.map((m) => {
    const offset_seconds = m * sigma;
    const r = rankCandidates(candidates, shiftOnset(incident, offset_seconds), config);
    const top = r.ranked[0];
    return {
      sigma_multiple: m,
      offset_seconds,
      top_cause_id: top?.candidate.cause_id ?? null,
      top_posterior: top?.posterior ?? 0,
    };
  });

  const stable = trials.filter((t) => t.top_cause_id === baseline_top_cause_id).length;
  const top_stability = trials.length ? stable / trials.length : 1;
  const flips = trials.filter((t) => t.top_cause_id !== baseline_top_cause_id);

  return { baseline_top_cause_id, onset_sigma_seconds_used: sigma, top_stability, trials, flips };
}
