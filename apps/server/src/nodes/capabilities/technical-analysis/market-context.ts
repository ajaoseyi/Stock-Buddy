/**
 * =============================================================================
 * market-context.ts — trend / momentum / volatility flags. DETERMINISTIC.
 * =============================================================================
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONE RULE THIS FILE EXISTS TO ENFORCE                                  │
 * │                                                                           │
 * │ Each function below is a documented FORMULA over already-computed         │
 * │ indicator values, returning a categorical LABEL — never a number, and     │
 * │ never a blend of trend/momentum/volatility into each other. Mirrors       │
 * │ `classifyQuadrant` (sector-leaders.ts) and `classifyGrowthAuthenticity`   │
 * │ (growth-classification.ts): the only thing produced is a label.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `volatilityLevel` is DELIBERATELY NOT an input to `stance-classification.ts`
 * — it is presented alongside trend/momentum as context only, the same role
 * `relativeVolume` plays relative to the weight/speed quadrant (CLAUDE.md
 * §5.4: "a SECONDARY confirmation signal ... never an input to the quadrant").
 */

import type { PriceBar } from "../../../tools/yahoo-finance.js";
import type { IndicatorSnapshot, TechnicalAnalysisResult } from "../../../state.js";
import { atr } from "../../../lib/technical-indicators.js";
import { robustZScore } from "../../../lib/stats.js";
import { usableBars } from "./indicator-snapshot.js";
import {
  ATR_PERIOD,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  VOLATILITY_BASELINE_LOOKBACK,
  VOLATILITY_MIN_BASELINE_POINTS,
  VOLATILITY_Z_THRESHOLD,
} from "./constants.js";

type TrendDirection = TechnicalAnalysisResult["trendDirection"];
type MomentumDirection = TechnicalAnalysisResult["momentumDirection"];
type VolatilityLevel = TechnicalAnalysisResult["volatilityLevel"];

/**
 * `close > sma50 > sma200` -> uptrend; the mirror-image ordering -> downtrend;
 * any other relative ordering (including a crossed/tangled state) -> sideways.
 * Any of the three inputs missing -> `insufficient_data` — never a guess at
 * which side of "sideways" a partial reading would fall on.
 */
export function computeTrendDirection(snapshot: IndicatorSnapshot): TrendDirection {
  const { latestClose, sma50, sma200 } = snapshot;
  if (latestClose === null || sma50 === null || sma200 === null) return "insufficient_data";

  if (latestClose > sma50 && sma50 > sma200) return "uptrend";
  if (latestClose < sma50 && sma50 < sma200) return "downtrend";
  return "sideways";
}

/** `rsi14 >= RSI_OVERBOUGHT` -> overbought; `<= RSI_OVERSOLD` -> oversold; otherwise neutral. Missing `rsi14` -> `insufficient_data`. */
export function computeMomentumDirection(snapshot: IndicatorSnapshot): MomentumDirection {
  const { rsi14 } = snapshot;
  if (rsi14 === null) return "insufficient_data";

  if (rsi14 >= RSI_OVERBOUGHT) return "overbought";
  if (rsi14 <= RSI_OVERSOLD) return "oversold";
  return "neutral";
}

/**
 * How today's ATR, as a percent of price, compares to its own trailing
 * history — reuses `lib/stats.ts`'s existing robust (median/MAD) z-score
 * infrastructure rather than inventing a parallel one, same as every other
 * "compare to own history" check in this codebase (CLAUDE.md §11.4/§11.5).
 *
 * Recomputes ATR from `bars` directly rather than reusing
 * `IndicatorSnapshot.atr14` (which is only the LATEST value) — this needs the
 * whole trailing series to build a baseline, not one point.
 */
export function computeVolatilityLevel(bars: PriceBar[]): VolatilityLevel {
  const bars_ = usableBars(bars);
  const atrSeries = atr(bars_, ATR_PERIOD);

  const atrPctSeries: number[] = [];
  for (let i = 0; i < bars_.length; i++) {
    const value = atrSeries[i] ?? null;
    const close = bars_[i]!.close;
    if (value !== null && close > 0) atrPctSeries.push((value / close) * 100);
  }

  if (atrPctSeries.length < 2) return "insufficient_data";

  const current = atrPctSeries.at(-1)!;
  const history = atrPctSeries.slice(0, -1).slice(-VOLATILITY_BASELINE_LOOKBACK);
  const z = robustZScore(history, current, VOLATILITY_MIN_BASELINE_POINTS);
  if (z === null) return "insufficient_data";

  if (z >= VOLATILITY_Z_THRESHOLD) return "high";
  if (z <= -VOLATILITY_Z_THRESHOLD) return "low";
  return "normal";
}
