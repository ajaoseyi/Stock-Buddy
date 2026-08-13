/**
 * =============================================================================
 * trade-levels-swing.ts — swing-methodology entry/stop/target. DETERMINISTIC.
 * =============================================================================
 *
 * The counterpart to `trade-levels-atr.ts`, computed from PRICE STRUCTURE
 * alone rather than a volatility formula: stop = just beyond the nearest raw
 * swing point, target = the next detected support/resistance level in the
 * trade's direction — genuinely `null` when no further level was detected,
 * NOT a fallback formula. That is the qualitative point of difference from
 * the ATR method's fixed reward:risk multiple, and it must stay visible: a
 * `null` target here is real information ("price structure gives no target"),
 * not a bug to paper over.
 *
 * Same null-degrade discipline and same "never merge with the ATR method's
 * levels" rule as `trade-levels-atr.ts` — see that file's header.
 */

import type { SupportResistanceLevel, TechnicalAnalysisResult } from "../../../state.js";
import type { SwingPoint } from "../../../lib/technical-indicators.js";
import { SWING_STOP_BUFFER_PCT } from "./constants.js";

type TechnicalStance = TechnicalAnalysisResult["stance"];
export interface SwingTradeLevels {
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  basisNote: string;
}

/**
 * The single raw swing point (not a clustered level) closest to the entry, of
 * the kind that matters for the trade direction — a swing LOW for a bullish
 * setup (the point the support level itself was built from), a swing HIGH for
 * a bearish one.
 */
export function selectNearestSwingPoint(
  swingPoints: SwingPoint[],
  stance: TechnicalStance,
  entryTrigger: number | null,
): SwingPoint | null {
  if (entryTrigger === null) return null;

  const kind =
    stance === "bullish_setup" ? "swing_low" : stance === "bearish_setup" ? "swing_high" : null;
  if (kind === null) return null;

  const candidates = swingPoints.filter((p) => p.kind === kind);
  if (candidates.length === 0) return null;

  return candidates.reduce((closest, point) =>
    Math.abs(point.price - entryTrigger) < Math.abs(closest.price - entryTrigger) ? point : closest,
  );
}

/**
 * The next detected level BEYOND the entry, in the trade's direction — the
 * nearest resistance above a bullish entry, or the nearest support below a
 * bearish one. Both level lists are already sorted nearest-first
 * (`support-resistance.ts`), so this is just the first element.
 */
export function selectNextLevel(
  stance: TechnicalStance,
  supportLevels: SupportResistanceLevel[],
  resistanceLevels: SupportResistanceLevel[],
): SupportResistanceLevel | null {
  if (stance === "bullish_setup") return resistanceLevels[0] ?? null;
  if (stance === "bearish_setup") return supportLevels[0] ?? null;
  return null;
}

export function computeSwingTradeLevels(
  stance: TechnicalStance,
  entryTrigger: number | null,
  nearestSwingPoint: SwingPoint | null,
  nextLevel: SupportResistanceLevel | null,
): SwingTradeLevels {
  if (stance !== "bullish_setup" && stance !== "bearish_setup") {
    return {
      entry: null,
      stopLoss: null,
      takeProfit: null,
      basisNote: `No swing-based levels: stance is "${stance}", not a directional setup.`,
    };
  }
  if (entryTrigger === null) {
    return {
      entry: null,
      stopLoss: null,
      takeProfit: null,
      basisNote: "No swing-based levels: no support/resistance level available to anchor an entry.",
    };
  }
  if (nearestSwingPoint === null) {
    return {
      entry: entryTrigger,
      stopLoss: null,
      takeProfit: nextLevel?.price ?? null,
      basisNote: "No swing-based stop: no raw swing point detected near the entry.",
    };
  }

  const buffer = SWING_STOP_BUFFER_PCT / 100;
  const stopLoss =
    stance === "bullish_setup"
      ? nearestSwingPoint.price * (1 - buffer)
      : nearestSwingPoint.price * (1 + buffer);

  return {
    entry: entryTrigger,
    stopLoss,
    takeProfit: nextLevel?.price ?? null,
    basisNote:
      stance === "bullish_setup"
        ? "Entry at the nearest support level; stop just below the nearest swing low; " +
          "target at the next detected resistance level, if any was found."
        : "Entry at the nearest resistance level; stop just above the nearest swing high; " +
          "target at the next detected support level, if any was found.",
  };
}
