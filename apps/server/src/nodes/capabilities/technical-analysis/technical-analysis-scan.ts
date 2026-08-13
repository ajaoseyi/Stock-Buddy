/**
 * =============================================================================
 * technical-analysis-scan.ts — run technical analysis for each resolved
 * target. DETERMINISTIC ORCHESTRATION, no LLM.
 * =============================================================================
 *
 * THE ONLY GRAPH NODE THIS CAPABILITY REGISTERS
 * ------------------------------------------------
 * Same deliberate deviation from growth-authenticity's five-node chain that
 * `company-snapshot-scan.ts`/`portfolio-growth-scan.ts` already made, for the
 * same reason: this capability is scoped to "a ticker, a few tickers, or a
 * sector" from day one (CLAUDE.md §14.1), so it needs the loop-over-targets
 * shape immediately — a chain of graph nodes wrapped in a loop would be pure
 * indirection. `indicator-snapshot.ts`/`market-context.ts`/
 * `support-resistance.ts`/`stance-classification.ts`/`trade-levels-*.ts` are
 * plain functions, not nodes; this file is the one real
 * `(state, now, config) => Promise<Partial<AgentState>>` node.
 *
 * ZERO NEW EXTERNAL CALLS. `fetchConstituentOhlcv`/`fetchSectorEtfHistory`
 * (tools/yahoo-finance.ts) are already fetched/cached by the industry-trend
 * capability — this capability spends no new Alpha Vantage quota at all
 * (CLAUDE.md §1's budget constraint), unlike every other capability so far.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, IndicatorSnapshot, TechnicalAnalysisResult } from "../../../state.js";
import { fetchConstituentOhlcv, fetchSectorEtfHistory } from "../../../tools/yahoo-finance.js";
import { emitProgress } from "../../../streaming.js";
import { resolveTechnicalAnalysisTargets, type ResolvedTarget } from "./resolve-targets.js";
import { computeIndicatorSnapshot } from "./indicator-snapshot.js";
import {
  computeMomentumDirection,
  computeTrendDirection,
  computeVolatilityLevel,
} from "./market-context.js";
import { computeSupportResistance } from "./support-resistance.js";
import { classifyTechnicalStance } from "./stance-classification.js";
import { computeAtrTradeLevels } from "./trade-levels-atr.js";
import { computeSwingTradeLevels, selectNearestSwingPoint, selectNextLevel } from "./trade-levels-swing.js";
import { INDICATOR_LOOKBACK_WINDOW, MIN_BARS_FOR_INDICATORS } from "./constants.js";

const EMPTY_SNAPSHOT: IndicatorSnapshot = {
  sma20: null,
  sma50: null,
  sma200: null,
  ema12: null,
  ema26: null,
  rsi14: null,
  macd: { macdLine: null, signalLine: null, histogram: null },
  atr14: null,
  bollinger: { middle: null, upper: null, lower: null },
  latestClose: null,
  asOfDate: null,
};

/**
 * The honest result for a target with too little history to say anything —
 * MIN_BARS_FOR_INDICATORS not met, or the fetch itself failed. Mirrors §5.7's
 * recent-IPO handling: a missing signal, stated plainly, never a guess.
 */
function buildInsufficientResult(target: ResolvedTarget, timeWindow: string, reason: string): TechnicalAnalysisResult {
  return {
    symbol: target.symbol,
    requestedAs: target.requestedAs,
    sectorName: target.sectorName,
    timeWindow,
    indicators: EMPTY_SNAPSHOT,
    trendDirection: "insufficient_data",
    momentumDirection: "insufficient_data",
    volatilityLevel: "insufficient_data",
    supportLevels: [],
    resistanceLevels: [],
    atrLevels: { entry: null, stopLoss: null, takeProfit: null, basisNote: reason },
    swingLevels: { entry: null, stopLoss: null, takeProfit: null, basisNote: reason },
    stance: "insufficient_data",
    stanceReasonCodes: ["insufficient_data"],
  };
}

/**
 * The shared entry-trigger price: the nearest support for a bullish setup
 * (buying the pullback to support), the nearest resistance for a bearish one
 * (selling the rally to resistance). `null` when the stance is not
 * directional, or no relevant level was detected — both trade-level
 * methodologies degrade honestly from there (see `trade-levels-atr.ts`/
 * `trade-levels-swing.ts`).
 */
function deriveEntryTrigger(
  stance: TechnicalAnalysisResult["stance"],
  supportLevels: TechnicalAnalysisResult["supportLevels"],
  resistanceLevels: TechnicalAnalysisResult["resistanceLevels"],
): number | null {
  if (stance === "bullish_setup") return supportLevels[0]?.price ?? null;
  if (stance === "bearish_setup") return resistanceLevels[0]?.price ?? null;
  return null;
}

/**
 * READS  `tickers`, `sectors`, `timeWindow`
 * WRITES `technicalAnalysis`, `technicalAnalysisErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Sequential over targets (not `Promise.all`) — same one-thing-at-a-time
 * discipline every other multi-item loop in this codebase uses (§12.3,
 * §13.7), even though Yahoo publishes no documented rate limit.
 *
 * A per-target failure degrades that target's entry, never the whole batch
 * (§8's tool-layer-failure-must-not-crash-a-run rule) — same invariant
 * `companySnapshotScanNode`/`portfolioGrowthScanNode` already establish.
 */
export async function technicalAnalysisScanNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const technicalAnalysisErrors: string[] = [];

  const { targets, skipped, errors } = resolveTechnicalAnalysisTargets(state.tickers, state.sectors);
  technicalAnalysisErrors.push(...errors);

  if (targets.length === 0) {
    technicalAnalysisErrors.push("technical-analysis: no ticker or sector named — nothing to analyse.");
    return { technicalAnalysis: [], technicalAnalysisErrors };
  }

  if (skipped.length > 0) {
    technicalAnalysisErrors.push(
      `technical-analysis: analysing the first ${targets.length} symbols only — skipped ${skipped.join(", ")}.`,
    );
  }

  const technicalAnalysis: TechnicalAnalysisResult[] = [];

  for (const target of targets) {
    emitProgress(config, "technical_analysis_scan", `Running technical analysis on ${target.symbol}...`);

    try {
      const history =
        target.requestedAs === "sector_etf"
          ? await fetchSectorEtfHistory(target.symbol, INDICATOR_LOOKBACK_WINDOW, now)
          : await fetchConstituentOhlcv(target.symbol, INDICATOR_LOOKBACK_WINDOW, now);

      const bars = history.quotes;
      const usableCount = bars.filter(
        (b) => b.high !== null && b.low !== null && b.close !== null,
      ).length;

      if (usableCount < MIN_BARS_FOR_INDICATORS) {
        const reason =
          `Only ${usableCount} usable daily bars available (need at least ` +
          `${MIN_BARS_FOR_INDICATORS}) — insufficient price history for technical analysis.`;
        technicalAnalysisErrors.push(`${target.symbol}: ${reason}`);
        technicalAnalysis.push(buildInsufficientResult(target, state.timeWindow, reason));
        continue;
      }

      const snapshot = computeIndicatorSnapshot(bars);
      const trendDirection = computeTrendDirection(snapshot);
      const momentumDirection = computeMomentumDirection(snapshot);
      const volatilityLevel = computeVolatilityLevel(bars);
      const { swingPoints, supportLevels, resistanceLevels } = computeSupportResistance(
        bars,
        snapshot.latestClose,
      );
      const { stance, reasonCodes } = classifyTechnicalStance(trendDirection, momentumDirection);
      const entryTrigger = deriveEntryTrigger(stance, supportLevels, resistanceLevels);

      const atrLevels = computeAtrTradeLevels(stance, entryTrigger, snapshot.atr14);
      const nearestSwingPoint = selectNearestSwingPoint(swingPoints, stance, entryTrigger);
      const nextLevel = selectNextLevel(stance, supportLevels, resistanceLevels);
      const swingLevels = computeSwingTradeLevels(stance, entryTrigger, nearestSwingPoint, nextLevel);

      technicalAnalysis.push({
        symbol: target.symbol,
        requestedAs: target.requestedAs,
        sectorName: target.sectorName,
        timeWindow: state.timeWindow,
        indicators: snapshot,
        trendDirection,
        momentumDirection,
        volatilityLevel,
        supportLevels,
        resistanceLevels,
        atrLevels,
        swingLevels,
        stance,
        stanceReasonCodes: reasonCodes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      technicalAnalysisErrors.push(`${target.symbol}: technical analysis failed — ${message}`);
      technicalAnalysis.push(
        buildInsufficientResult(target, state.timeWindow, `Technical analysis failed: ${message}`),
      );
    }
  }

  return { technicalAnalysis, technicalAnalysisErrors };
}
