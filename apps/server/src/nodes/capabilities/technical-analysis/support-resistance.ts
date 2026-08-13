/**
 * =============================================================================
 * support-resistance.ts — swing detection + level clustering. DETERMINISTIC.
 * =============================================================================
 *
 * Runs `detectSwingPoints`/`clusterLevels` (lib/technical-indicators.ts) over
 * the fetched bars, then splits the merged levels into support (below the
 * current price) vs. resistance (above it) — a level is "support" only
 * because it currently sits below where the stock trades, which is why that
 * classification happens HERE, in the capability layer, rather than in the
 * price-agnostic library function (see that file's header on `clusterLevels`).
 *
 * Exposes BOTH the raw `swingPoints` (the trade-level formulas in
 * `trade-levels-swing.ts` want the single nearest raw extreme, not a merged
 * level) and the clustered `supportLevels`/`resistanceLevels` (needed for the
 * ATR method's stop reference, the shared entry trigger, and the swing
 * method's "next level" target).
 */

import type { PriceBar } from "../../../tools/yahoo-finance.js";
import type { SupportResistanceLevel } from "../../../state.js";
import { clusterLevels, detectSwingPoints, type SwingPoint } from "../../../lib/technical-indicators.js";
import { usableBars } from "./indicator-snapshot.js";
import { MAX_LEVELS_PER_SIDE, SR_CLUSTER_TOLERANCE_PCT, SWING_LOOKBACK_BARS } from "./constants.js";

export interface SupportResistanceResult {
  swingPoints: SwingPoint[];
  /** Nearest-first (highest support first, since it's closest to the current price from below). */
  supportLevels: SupportResistanceLevel[];
  /** Nearest-first (lowest resistance first, closest to the current price from above). */
  resistanceLevels: SupportResistanceLevel[];
}

export function computeSupportResistance(
  bars: PriceBar[],
  currentPrice: number | null,
): SupportResistanceResult {
  const swingPoints = detectSwingPoints(usableBars(bars), SWING_LOOKBACK_BARS);

  if (currentPrice === null || swingPoints.length === 0) {
    return { swingPoints, supportLevels: [], resistanceLevels: [] };
  }

  const clustered = clusterLevels(swingPoints, SR_CLUSTER_TOLERANCE_PCT);

  const supportLevels: SupportResistanceLevel[] = clustered
    .filter((l) => l.price < currentPrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_LEVELS_PER_SIDE)
    .map((l) => ({ price: l.price, kind: "support", touches: l.touches }));

  const resistanceLevels: SupportResistanceLevel[] = clustered
    .filter((l) => l.price > currentPrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, MAX_LEVELS_PER_SIDE)
    .map((l) => ({ price: l.price, kind: "resistance", touches: l.touches }));

  return { swingPoints, supportLevels, resistanceLevels };
}
