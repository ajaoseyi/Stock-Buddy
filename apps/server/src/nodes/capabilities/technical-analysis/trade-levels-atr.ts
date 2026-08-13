/**
 * =============================================================================
 * trade-levels-atr.ts — ATR-methodology entry/stop/target. DETERMINISTIC.
 * =============================================================================
 *
 * `stopLoss = entryTrigger -+ ATR_STOP_MULTIPLE * atr14` and
 * `takeProfit = entry -+ ATR_RISK_REWARD_MULTIPLE * (entry - stopLoss)` are
 * SINGLE DOCUMENTED FORMULAS over one already-selected support/resistance
 * level and one already-computed indicator value — the same category as
 * `ev_to_ebitda = enterpriseValue / ebitda` (CLAUDE.md §13.5), NOT "blending
 * independent signals into a score" (§9). `trendDirection`/`momentumDirection`
 * already combined into the `stance` LABEL upstream
 * (`stance-classification.ts`); nothing here re-touches that decision, it only
 * turns an already-decided direction into concrete prices.
 *
 * Kept in its OWN object, never merged with `trade-levels-swing.ts`'s output —
 * confirmed product decision: the two methodologies are independently
 * computed and always presented as two distinct sets of levels, never as one
 * "the stop-loss".
 *
 * Every field degrades to `null` (never guessed) when a precondition is
 * missing — the same "a missing signal is honest" principle as CLAUDE.md
 * §5.9(b)/§11.9(b), applied here to a PRICE rather than a classification flag.
 */

import type { TechnicalAnalysisResult } from "../../../state.js";
import { ATR_RISK_REWARD_MULTIPLE, ATR_STOP_MULTIPLE } from "./constants.js";

type TechnicalStance = TechnicalAnalysisResult["stance"];
export interface AtrTradeLevels {
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  basisNote: string;
}

export function computeAtrTradeLevels(
  stance: TechnicalStance,
  entryTrigger: number | null,
  atr14: number | null,
): AtrTradeLevels {
  if (stance !== "bullish_setup" && stance !== "bearish_setup") {
    return {
      entry: null,
      stopLoss: null,
      takeProfit: null,
      basisNote: `No ATR-based levels: stance is "${stance}", not a directional setup.`,
    };
  }
  if (entryTrigger === null) {
    return {
      entry: null,
      stopLoss: null,
      takeProfit: null,
      basisNote: "No ATR-based levels: no support/resistance level available to anchor an entry.",
    };
  }
  if (atr14 === null) {
    return {
      entry: null,
      stopLoss: null,
      takeProfit: null,
      basisNote: "No ATR-based levels: ATR(14) is not computable from the available price history.",
    };
  }

  if (stance === "bullish_setup") {
    const stopLoss = entryTrigger - ATR_STOP_MULTIPLE * atr14;
    const takeProfit = entryTrigger + ATR_RISK_REWARD_MULTIPLE * (entryTrigger - stopLoss);
    return {
      entry: entryTrigger,
      stopLoss,
      takeProfit,
      basisNote:
        `Entry at the nearest support level; stop ${ATR_STOP_MULTIPLE}x ATR(14) below it; ` +
        `target at a ${ATR_RISK_REWARD_MULTIPLE}:1 reward-to-risk multiple of the entry-to-stop distance.`,
    };
  }

  const stopLoss = entryTrigger + ATR_STOP_MULTIPLE * atr14;
  const takeProfit = entryTrigger - ATR_RISK_REWARD_MULTIPLE * (stopLoss - entryTrigger);
  return {
    entry: entryTrigger,
    stopLoss,
    takeProfit,
    basisNote:
      `Entry at the nearest resistance level; stop ${ATR_STOP_MULTIPLE}x ATR(14) above it; ` +
      `target at a ${ATR_RISK_REWARD_MULTIPLE}:1 reward-to-risk multiple of the entry-to-stop distance.`,
  };
}
