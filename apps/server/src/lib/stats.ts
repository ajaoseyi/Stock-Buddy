/**
 * =============================================================================
 * stats.ts — shared robust statistics helpers (median/MAD z-score).
 * =============================================================================
 *
 * Promoted out of `nodes/capabilities/growth-authenticity/stats.ts` once a
 * third consumer appeared — that file's own header stated the policy
 * explicitly: "a ~15-line duplication is the right size... revisit only once
 * a third consumer appears." `nodes/capabilities/growth-authenticity/
 * {inorganic-signal,price-revenue-discrepancy,sector-benchmark}.ts` were the
 * first two; `nodes/capabilities/company-snapshot/{valuation-metrics,
 * financial-health}.ts` (CLAUDE.md §13.5/§13.6) need the identical
 * peer-relative robust z-score operation, which is the third-consumer
 * trigger. Promoted here rather than duplicated a third time.
 *
 * MEDIAN and MAD (median absolute deviation) are used instead of mean/stdDev
 * specifically because they resist a single-outlier problem — one genuine
 * past event (an acquisition, an earnings collapse, or here, one unusually
 * priced peer) should not blow out the baseline and mask a real signal.
 */

/**
 * Minimum historical/peer points required before a baseline is trusted at
 * all. Below this, callers degrade honestly to "no signal"/
 * "insufficient_history"/"not_computable" rather than computing an unreliable
 * statistic from too little data (CLAUDE.md §5.9(b)).
 *
 * RESOLVED against live data (CLAUDE.md §11.9) for the growth-authenticity
 * use of this constant — was a placeholder of 6, lowered to 3, the real
 * ceiling Yahoo's `fundamentalsTimeSeries` endpoint can supply. Company-
 * snapshot's peer-sample use of this same constant (§13.10) has not yet been
 * separately calibrated — see §13.11's resolved-notes placeholder.
 */
export const MIN_BASELINE_QUARTERS = 3;

/**
 * |z| at or beyond this counts as "notably different from the baseline". Not
 * yet calibrated against a case where a z-score was actually produced from
 * real, non-empty history for either consumer — see CLAUDE.md §11.9's "still
 * open" note and §13.11's placeholder.
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
 * extreme values in a way stdDev is not.
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
