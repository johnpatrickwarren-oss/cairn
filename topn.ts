// engine/cairn/topn.ts — top-N attribution slice (Wtn).
//
// Pure, READ-ONLY helper to take the leading N ranked candidates from a
// RankedAttribution (for summaries that show only the top causes). Does not
// score, rank, or mutate — ranked.ranked is already posterior-sorted.

import type { RankedAttribution, ScoredCandidate } from './types';

/** The first `n` ranked candidates (already posterior-sorted). n ≤ 0 → []; n larger
 *  than the set → the whole set. Returns a new array; never mutates the input. */
export function topCandidates(ranked: RankedAttribution, n: number): ScoredCandidate[] {
  if (n <= 0) return [];
  return ranked.ranked.slice(0, n);
}
