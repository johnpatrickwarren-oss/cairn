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
  /** posterior of ranked[0] (already in [0,1]); 0 when the ranked set is empty.
   *  Full float precision — distinct from the rounded display in headline. */
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
