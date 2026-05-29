// calibration.ts — Cairn calibration / backtesting harness (Q32).
//
// Read-only diagnostics over the v1 scorer. Given labeled incidents, measures
// accuracy (top-1/top-k, MRR) and calibration (multi-class Brier, reliability
// bins, ECE). Pure + deterministic (no RNG, no clock). Never mutates the
// scorer or its config — measurement, not optimization.
//
// See coordination/Q32-CAIRN-CALIBRATION-SPEC.md.

import type {
  LabeledScenario, CalibrationOptions, CalibrationReport,
  ScenarioOutcome, ReliabilityBin,
} from './types';
import { rankCandidates } from './score';

export const DEFAULT_K_VALUES: readonly number[] = [1, 3];
export const DEFAULT_BIN_COUNT = 10;

/** Run the scorer on one labeled scenario and extract the calibration
 *  quantities (rank of the true cause, top-confidence, multi-class Brier). */
export function scoreScenario(scenario: LabeledScenario): ScenarioOutcome {
  const { incident, candidates, true_cause_id } = scenario;
  const ranked = rankCandidates(candidates, incident, scenario.config ?? {});

  // 1-based rank of the true cause in ranked[]; if duplicated (malformed
  // input) findIndex takes the best (lowest) rank. null if not ranked.
  const idx = ranked.ranked.findIndex((s) => s.candidate.cause_id === true_cause_id);
  const true_cause_rank = idx >= 0 ? idx + 1 : null;
  const true_cause_posterior = idx >= 0 ? ranked.ranked[idx].posterior : 0;

  const top = ranked.ranked[0];
  const predicted_top_cause_id = top?.candidate.cause_id ?? null;
  const top_confidence = top?.posterior ?? 0;
  const top_correct = predicted_top_cause_id === true_cause_id;
  const reciprocal_rank = true_cause_rank ? 1 / true_cause_rank : 0;

  // Multi-class Brier over the FULL candidate set (ranked ∪ suppressed):
  // y_c = 1 for the true cause else 0; p_c = posterior if ranked else 0.
  // A suppressed/absent true cause costs the full (0 − 1)² = 1.
  let brier = 0;
  for (const s of ranked.ranked) {
    const y = s.candidate.cause_id === true_cause_id ? 1 : 0;
    brier += (s.posterior - y) ** 2;
  }
  for (const sup of ranked.suppressed) {
    const y = sup.candidate.cause_id === true_cause_id ? 1 : 0;
    brier += (0 - y) ** 2;
  }

  return {
    incident_id: incident.incident_id,
    true_cause_id,
    predicted_top_cause_id,
    true_cause_rank,
    true_cause_posterior,
    top_confidence,
    top_correct,
    reciprocal_rank,
    brier,
  };
}

/** Equal-width reliability bins over the top-candidate confidence. Empty bins
 *  are dropped (they carry no information and would divide by zero). */
export function reliabilityBins(outcomes: ScenarioOutcome[], binCount: number): ReliabilityBin[] {
  const buckets: ScenarioOutcome[][] = Array.from({ length: binCount }, () => []);
  for (const o of outcomes) {
    const i = Math.min(binCount - 1, Math.floor(o.top_confidence * binCount));
    buckets[i].push(o);
  }
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const b = buckets[i];
    if (b.length === 0) continue;
    const mean_confidence = b.reduce((a, o) => a + o.top_confidence, 0) / b.length;
    const empirical_accuracy = b.filter((o) => o.top_correct).length / b.length;
    bins.push({
      lower: i / binCount,
      upper: (i + 1) / binCount,
      count: b.length,
      mean_confidence,
      empirical_accuracy,
    });
  }
  return bins;
}

/** Backtest the scorer over labeled scenarios; report accuracy + calibration. */
export function calibrate(
  scenarios: LabeledScenario[],
  opts: CalibrationOptions = {},
): CalibrationReport {
  const k_values = opts.k_values ?? [...DEFAULT_K_VALUES];
  const bin_count = opts.bin_count ?? DEFAULT_BIN_COUNT;

  const per_scenario = scenarios.map(scoreScenario);
  const n = per_scenario.length;

  if (n === 0) {
    return {
      n: 0, top1_accuracy: 0,
      topk_accuracy: k_values.map((k) => ({ k, accuracy: 0 })),
      mrr: 0, brier_score: 0, ece: 0, reliability_bins: [], per_scenario,
    };
  }

  const top1_accuracy = per_scenario.filter((o) => o.top_correct).length / n;
  const topk_accuracy = k_values.map((k) => ({
    k,
    accuracy: per_scenario.filter((o) => o.true_cause_rank !== null && o.true_cause_rank <= k).length / n,
  }));
  const mrr = per_scenario.reduce((a, o) => a + o.reciprocal_rank, 0) / n;
  const brier_score = per_scenario.reduce((a, o) => a + o.brier, 0) / n;

  const reliability_bins = reliabilityBins(per_scenario, bin_count);
  const ece = reliability_bins.reduce(
    (a, b) => a + (b.count / n) * Math.abs(b.mean_confidence - b.empirical_accuracy),
    0,
  );

  return { n, top1_accuracy, topk_accuracy, mrr, brier_score, ece, reliability_bins, per_scenario };
}
