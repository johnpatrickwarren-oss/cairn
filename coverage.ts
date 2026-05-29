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
