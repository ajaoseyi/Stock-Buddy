/**
 * =============================================================================
 * stats.ts — robust statistics helpers, local to growth-authenticity.
 * =============================================================================
 *
 * Deliberately NOT shared with `sector-leaders.ts`'s `mean`/`stdDev`/`zScore`
 * helpers, even though the shapes rhyme. Two reasons:
 *
 *   1. CLAUDE.md §3: a capability lives entirely under its own folder.
 *      Cross-capability imports would violate that containment.
 *   2. These are genuinely different statistics for a genuinely different
 *      purpose. `sector-leaders.ts` z-scores a constituent against its
 *      SECTOR's distribution with mean/stdDev — appropriate there, because one
 *      bad company doesn't skew its own score. Here we z-score a company's
 *      CURRENT quarter against ITS OWN trailing history, and that history can
 *      contain a single genuine past event (an actual prior acquisition, a
 *      real earnings collapse) that would blow out a mean/stdDev baseline and
 *      mask a new one. MEDIAN and MAD (median absolute deviation) are used
 *      instead specifically because they resist that single-outlier problem.
 *
 * A ~15-line duplication is the right size for "not worth a shared
 * `src/lib/stats.ts` yet" — CLAUDE.md's own stated aversion to premature
 * generalisation. Revisit only once a third consumer appears.
 */

/**
 * Minimum historical points required before a baseline is trusted at all.
 * Below this, callers degrade honestly to "no signal"/"insufficient_history"
 * rather than computing an unreliable statistic from too little data
 * (CLAUDE.md §5.9(b)).
 *
 * RESOLVED against live data (CLAUDE.md §11.9) — was a placeholder of 6,
 * lowered to 3. Yahoo's free `fundamentalsTimeSeries` endpoint was verified
 * (live calls, APA and COST, `period1` back to 2018) to return a FIXED ~5
 * usable quarters (~15 months) no matter how far back it's asked to look —
 * the "~4yr window → 8-16 quarters" design assumption did not survive contact
 * with the data. From 5 real quarters, the QoQ-spaced series `inorganic-
 * signal.ts` needs (goodwill/PP&E/cash) can produce at most 3 historical
 * deltas — confirmed live (`baselineQuarterCount: 3` on both tickers).
 * 6 would make that baseline permanently unreachable; 3 is the real ceiling,
 * not a guess. The YoY-spaced series `price-revenue-discrepancy.ts` needs is
 * a harder case — it structurally cannot reach even 3 from ~15 months of
 * data, since each historical point itself needs a prior-year comparator.
 * That case reports `discrepancyFlag: "insufficient_history"` honestly
 * (added for this reason — see the schema comment in state.ts) rather than
 * lowering this constant further to paper over a gap in the data source.
 */
export const MIN_BASELINE_QUARTERS = 3;

/**
 * |z| at or beyond this counts as "notably different from this company's own
 * history". Left at the original placeholder — live calibration surfaced a
 * baseline-*availability* problem (see `MIN_BASELINE_QUARTERS`) severe enough
 * to fix first; this cutoff has not yet been checked against a case where a
 * z-score was actually produced from real data, e.g. a company with 3+
 * genuine historical PP&E deltas and a live inorganic event within them.
 * Revisit once such a case is captured as a fixture (CLAUDE.md §11.9).
 */
export const ROBUST_Z_THRESHOLD = 2;

/** Median of a numeric array. Returns 0 for an empty input so callers need no guard. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Median absolute deviation: the median of |xi − median(x)|.
 *
 * The robust analogue of standard deviation — resistant to a small number of
 * extreme values in a way stdDev is not, which is the whole reason it is used
 * here instead of the `sector-leaders.ts` mean/stdDev approach.
 */
export function medianAbsoluteDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** Clamp applied to a z-score when MAD is 0, so the result stays a well-behaved number. */
const CLAMP = 10;

/**
 * How many (robust, MAD-scaled) standard deviations `current` sits from the
 * median of `history`.
 *
 * `0.6745` is the standard constant that makes MAD comparable to a normal
 * distribution's standard deviation (MAD ≈ 0.6745·σ for normal data), so the
 * result is on the same rough scale as a familiar (x − mean) / stdDev z-score.
 *
 * Returns `null` when `history` has fewer than `minSamples` points — admitting
 * a missing baseline honestly rather than computing an unreliable one
 * (CLAUDE.md §5.9(b): "a missing signal is honest; a confident wrong one is
 * not").
 *
 * When MAD is 0 (every historical point identical), any genuine change from
 * that constant is a real, extreme deviation — clamped to ±`CLAMP` rather than
 * `Infinity` so it stays usable in threshold comparisons and JSON output.
 */
export function robustZScore(
  history: number[],
  current: number,
  minSamples: number = MIN_BASELINE_QUARTERS,
): number | null {
  if (history.length < minSamples) return null;

  const m = median(history);
  const mad = medianAbsoluteDeviation(history);

  if (mad === 0) {
    if (current === m) return 0;
    return current > m ? CLAMP : -CLAMP;
  }

  const z = (0.6745 * (current - m)) / mad;
  return Math.max(-CLAMP, Math.min(CLAMP, z));
}
