/**
 * =============================================================================
 * stance-classification.ts — reduce trend + momentum to one stance.
 * DETERMINISTIC.
 * =============================================================================
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONE RULE THIS FILE EXISTS TO ENFORCE                                  │
 * │                                                                           │
 * │ `classifyTechnicalStance` is an ORDERED IF/ELSE CHAIN over two            │
 * │ categorical flags — not a cross-product lookup table, and no line here    │
 * │ adds, multiplies, or averages a number. Mirrors `classifyGrowthAuthenticity` │
 * │ (growth-authenticity/growth-classification.ts) exactly: the only thing    │
 * │ produced is a LABEL.                                                      │
 * │                                                                           │
 * │ `volatilityLevel` is DELIBERATELY NOT an input here (see                  │
 * │ market-context.ts's header) — only `trendDirection`/`momentumDirection`   │
 * │ feed this decision.                                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Order matters:
 *   1. Either input `insufficient_data` -> the whole stance is
 *      `insufficient_data`. Nothing else can be claimed with one leg missing.
 *   2. `uptrend` + NOT `overbought` -> `bullish_setup` — a trend already
 *      moving up, with momentum that has not already spent itself, is the
 *      textbook "pullback/continuation" setup this capability exists to flag.
 *      `uptrend` + `overbought` deliberately does NOT qualify: buying into an
 *      overbought reading inside an uptrend is exactly the setup most likely
 *      to mean-revert against the trade.
 *   3. `downtrend` + NOT `oversold` -> `bearish_setup`, the mirror image.
 *   4. Anything else (a `sideways` trend, or a trend directly contradicted by
 *      an exhausted momentum reading) -> `neutral_no_setup` — an honest "no
 *      trade here" rather than forcing a direction.
 */

import type { TechnicalAnalysisResult } from "../../../state.js";

type TrendDirection = TechnicalAnalysisResult["trendDirection"];
type MomentumDirection = TechnicalAnalysisResult["momentumDirection"];
type TechnicalStance = TechnicalAnalysisResult["stance"];

export function classifyTechnicalStance(
  trend: TrendDirection,
  momentum: MomentumDirection,
): { stance: TechnicalStance; reasonCodes: string[] } {
  const reasonCodes = [`trend:${trend}`, `momentum:${momentum}`];

  if (trend === "insufficient_data" || momentum === "insufficient_data") {
    return { stance: "insufficient_data", reasonCodes };
  }
  if (trend === "uptrend" && momentum !== "overbought") {
    return { stance: "bullish_setup", reasonCodes };
  }
  if (trend === "downtrend" && momentum !== "oversold") {
    return { stance: "bearish_setup", reasonCodes };
  }
  return { stance: "neutral_no_setup", reasonCodes };
}
