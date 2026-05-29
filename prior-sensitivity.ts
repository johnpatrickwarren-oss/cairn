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
  const uniform = rankCandidates(
    candidates,
    incident,
    uniformPriorConfig(candidates, config),
  );

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
