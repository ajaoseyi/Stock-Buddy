/**
 * =============================================================================
 * price-revenue-discrepancy.ts — is the price move backed by revenue? DETERMINISTIC.
 * =============================================================================
 *
 * Second node in the growth-authenticity pipeline (see ./index.ts). No LLM,
 * ever (§1, §9).
 *
 * THE CASE THIS FILE EXISTS TO CATCH
 * -----------------------------------
 * A stock up 40% while revenue grew 2% is the headline "illusion of growth"
 * case. `priceToRevenueGrowthRatio` is only ever computed when revenue growth
 * is strictly positive — dividing by a flat-or-declining figure has no
 * meaningful interpretation, so that case is instead an explicit
 * `discrepancyFlag` rather than a silent NaN/Infinity.
 *
 * THE BASELINE IS THE COMPANY'S OWN HISTORY, NOT A FLAT CONSTANT
 * ----------------------------------------------------------------
 * A flat "ratio >= 2.0 is suspicious" cutoff is wrong in both directions: a
 * high-multiple growth stock's normal ratio and a value stock's normal ratio
 * are not the same number, so a universal constant either over- or
 * under-flags depending which kind of company it's applied to. Instead, the
 * current ratio is expressed as a robust (median/MAD) z-score against this
 * SAME company's own trailing ~8-16 quarter-end ratios — computed by pairing
 * each historical quarter's YoY revenue growth with the trailing-12-month
 * price return ending at that same quarter-end.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, DiscrepancyResult } from "../../../state.js";
import { emitProgress } from "../../../streaming.js";
import {
  fetchConstituentOhlcv,
  fetchQuarterlyFinancials,
  resolveWindowStart,
  type PriceBar,
  type QuarterlyFinancialsRow,
} from "../../../tools/yahoo-finance.js";
import { findYoyPriorRow, usableRevenueRows } from "./revenue-growth.js";
import { MIN_BASELINE_QUARTERS, ROBUST_Z_THRESHOLD, robustZScore } from "./stats.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How much history to pull for the own-history baseline (§3 of the plan). */
const BASELINE_LOOKBACK_WINDOW = "5y";

/** How close a price bar must be to a target date to count as "at" it. */
const PRICE_LOOKUP_TOLERANCE_DAYS = 10;
/** Wider tolerance for the "1 year before" leg — trading calendars drift. */
const TRAILING_RETURN_TOLERANCE_DAYS = 15;

const notComputable = (): DiscrepancyResult => ({
  priceChangePct: null,
  priceToRevenueGrowthRatio: null,
  ratioZScore: null,
  baselineQuarterCount: 0,
  discrepancyFlag: "not_computable",
});

/**
 * Percent change between the first and last usable bar. Deliberately a local
 * copy of `sector-trend.ts`'s `computePctChange` rather than an import —
 * CLAUDE.md §3's capability containment rule, applied to a ~10-line helper
 * duplicated once, not a shared cross-capability dependency.
 */
export function computePctChangeFromBars(bars: PriceBar[]): number | null {
  const usable = bars
    .map((bar) => bar.adjclose ?? bar.close)
    .filter((price): price is number => price !== null && price !== undefined && price > 0);

  if (usable.length < 2) return null;
  const first = usable[0]!;
  const last = usable.at(-1)!;
  return ((last - first) / first) * 100;
}

/** One usable price point: a positive close/adjclose on a known date. */
interface PricePoint {
  date: Date;
  price: number;
}

function toPricePoints(bars: PriceBar[]): PricePoint[] {
  return bars
    .map((bar) => ({ date: bar.date, price: bar.adjclose ?? bar.close }))
    .filter((p): p is PricePoint => p.price !== null && p.price !== undefined && p.price > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** The price at (or within tolerance of, on-or-before) `target`, else `null`. */
function priceNear(points: PricePoint[], target: Date, toleranceDays: number): number | null {
  let best: PricePoint | null = null;
  for (const point of points) {
    if (point.date.getTime() > target.getTime()) break;
    best = point;
  }
  if (best === null) return null;
  const diffDays = (target.getTime() - best.date.getTime()) / MS_PER_DAY;
  return diffDays <= toleranceDays ? best.price : null;
}

/** Trailing-12-month % price return ending at `quarterEnd`, or `null` if not computable. */
function trailingReturnEndingAt(points: PricePoint[], quarterEnd: Date): number | null {
  const endPrice = priceNear(points, quarterEnd, PRICE_LOOKUP_TOLERANCE_DAYS);
  if (endPrice === null) return null;

  const startTarget = new Date(quarterEnd.getTime() - 365 * MS_PER_DAY);
  const startPrice = priceNear(points, startTarget, TRAILING_RETURN_TOLERANCE_DAYS);
  if (startPrice === null || startPrice <= 0) return null;

  return ((endPrice - startPrice) / startPrice) * 100;
}

/**
 * Build the company's own historical price/revenue-growth ratio series,
 * EXCLUDING the current (latest) quarter — that one is the point being
 * tested, not part of its own baseline.
 *
 * Only quarters with strictly positive YoY revenue growth contribute a ratio,
 * matching the rule that governs the current-quarter case (§ above).
 *
 * Exported for direct unit testing.
 */
export function computeHistoricalRatios(
  financialRows: QuarterlyFinancialsRow[],
  priceBars: PriceBar[],
): number[] {
  const usable = usableRevenueRows(financialRows);
  const points = toPricePoints(priceBars);
  const ratios: number[] = [];

  // Exclude the last index — that is the current quarter, handled separately.
  for (let i = 0; i < usable.length - 1; i++) {
    const row = usable[i]!;
    const prior = findYoyPriorRow(usable, i);
    if (prior === null || prior.totalRevenue <= 0) continue;

    const revenueGrowthPct = ((row.totalRevenue - prior.totalRevenue) / prior.totalRevenue) * 100;
    if (revenueGrowthPct <= 0) continue;

    const priceReturnPct = trailingReturnEndingAt(points, row.date);
    if (priceReturnPct === null) continue;

    ratios.push(priceReturnPct / revenueGrowthPct);
  }

  return ratios;
}

/**
 * READS  `tickers`, `timeWindow`, `revenueGrowth`
 * WRITES `priceRevenueDiscrepancy`, `growthCheckErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * MUST run after `revenueGrowthNode`, which populates `state.revenueGrowth`.
 */
export async function priceRevenueDiscrepancyNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const growthCheckErrors = [...state.growthCheckErrors];
  const ticker = state.tickers[0];
  const revenueGrowth = state.revenueGrowth;

  if (ticker === undefined || revenueGrowth === null) {
    return { priceRevenueDiscrepancy: notComputable(), growthCheckErrors };
  }

  emitProgress(
    config,
    "price_revenue_discrepancy",
    `Comparing ${ticker}'s price move to its revenue growth...`,
  );

  // --- Current-window price change -------------------------------------------
  let currentBars;
  try {
    currentBars = await fetchConstituentOhlcv(ticker, state.timeWindow, now);
  } catch (error) {
    growthCheckErrors.push(
      `${ticker}: price history unavailable — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { priceRevenueDiscrepancy: notComputable(), growthCheckErrors };
  }

  // §5.7's recent-IPO case: a company listed after the window opened has no
  // meaningful return over that window.
  const windowStart = resolveWindowStart(state.timeWindow, now);
  const firstTrade = currentBars.meta.firstTradeDate;
  if (firstTrade instanceof Date && firstTrade.getTime() > windowStart.getTime()) {
    growthCheckErrors.push(
      `${ticker}: listed ${firstTrade.toISOString().slice(0, 10)}, after the ` +
        `"${state.timeWindow}" window opened — price/revenue discrepancy not computable.`,
    );
    return { priceRevenueDiscrepancy: notComputable(), growthCheckErrors };
  }

  const priceChangePct = computePctChangeFromBars(currentBars.quotes);
  if (priceChangePct === null) {
    growthCheckErrors.push(
      `${ticker}: insufficient price data over "${state.timeWindow}" for price/revenue discrepancy.`,
    );
    return { priceRevenueDiscrepancy: notComputable(), growthCheckErrors };
  }

  const revenueGrowthPct = revenueGrowth.revenueGrowthPct;

  // --- Case matrix (Appendix B of the plan) -----------------------------------
  if (revenueGrowthPct === null) {
    return {
      priceRevenueDiscrepancy: { ...notComputable(), priceChangePct },
      growthCheckErrors,
    };
  }

  if (revenueGrowthPct <= 0) {
    // Ratio against flat/declining revenue is meaningless — not a silent
    // NaN/Infinity, an explicit flag instead.
    const discrepancyFlag = priceChangePct > 0 ? "price_outpacing_revenue" : "aligned";
    return {
      priceRevenueDiscrepancy: {
        priceChangePct,
        priceToRevenueGrowthRatio: null,
        ratioZScore: null,
        baselineQuarterCount: 0,
        discrepancyFlag,
      },
      growthCheckErrors,
    };
  }

  const ratio = priceChangePct / revenueGrowthPct;

  // --- Own-history baseline ----------------------------------------------------
  let historicalRatios: number[] = [];
  try {
    const [financialRows, longBars] = await Promise.all([
      fetchQuarterlyFinancials(ticker, now),
      fetchConstituentOhlcv(ticker, BASELINE_LOOKBACK_WINDOW, now),
    ]);
    historicalRatios = computeHistoricalRatios(financialRows, longBars.quotes);
  } catch (error) {
    growthCheckErrors.push(
      `${ticker}: historical price/revenue baseline unavailable — ` +
        `${error instanceof Error ? error.message : String(error)}. Discrepancy flag reports ` +
        `"insufficient_history" rather than assuming alignment.`,
    );
  }

  const ratioZScore = robustZScore(historicalRatios, ratio);

  let discrepancyFlag: DiscrepancyResult["discrepancyFlag"];
  if (ratioZScore === null) {
    // "insufficient_history", NOT "aligned" — a missing baseline is a
    // different claim than "checked, and no discrepancy found" (CLAUDE.md
    // §5.9(b) / §11.9). Verified against live data that this is the COMMON
    // case, not an edge case: Yahoo's free fundamentals endpoint returns a
    // fixed ~5 usable quarters regardless of how far back it's asked to look,
    // which structurally cannot satisfy a YoY-spaced baseline most of the
    // time. Silently reporting "aligned" here previously hid a real ~12.6x
    // price/revenue ratio on live APA data behind the calmest possible label.
    discrepancyFlag = "insufficient_history";
    growthCheckErrors.push(
      `${ticker}: only ${historicalRatios.length} historical quarter(s) available for the ` +
        `price/revenue baseline (need ${MIN_BASELINE_QUARTERS}) — reporting "insufficient_history" ` +
        `rather than guessing whether the current ratio (${ratio.toFixed(2)}x) is unusual.`,
    );
  } else if (ratioZScore >= ROBUST_Z_THRESHOLD) {
    discrepancyFlag = "price_outpacing_revenue";
  } else if (ratioZScore <= -ROBUST_Z_THRESHOLD) {
    discrepancyFlag = "revenue_outpacing_price";
  } else {
    discrepancyFlag = "aligned";
  }

  return {
    priceRevenueDiscrepancy: {
      priceChangePct,
      priceToRevenueGrowthRatio: ratio,
      ratioZScore,
      baselineQuarterCount: historicalRatios.length,
      discrepancyFlag,
    },
    growthCheckErrors,
  };
}
