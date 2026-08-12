/**
 * =============================================================================
 * revenue-growth.ts — YoY quarterly revenue growth for one ticker. DETERMINISTIC.
 * =============================================================================
 *
 * First node in the growth-authenticity pipeline (see ./index.ts). No LLM,
 * ever (§1, §9).
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, RevenueGrowthResult } from "../../../state.js";
import { emitProgress } from "../../../streaming.js";
import {
  fetchQuarterlyFinancials,
  type QuarterlyFinancialsRow,
} from "../../../tools/yahoo-finance.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Tolerance band, in days, for matching "the same quarter one year earlier".
 * Real quarterly data is not guaranteed perfectly contiguous — a fixed `-4`
 * index offset would silently misalign across a missing quarter, the same
 * class of bug CLAUDE.md §5.8(a) already documents once for sector cross-check
 * date-range alignment.
 */
export const YOY_TOLERANCE_DAYS_MIN = 335;
export const YOY_TOLERANCE_DAYS_MAX = 395;

/** Rows with a defined `totalRevenue`, sorted oldest to newest. */
export function usableRevenueRows(
  rows: QuarterlyFinancialsRow[],
): (QuarterlyFinancialsRow & { totalRevenue: number })[] {
  return rows
    .filter(
      (r): r is QuarterlyFinancialsRow & { totalRevenue: number } => r.totalRevenue !== undefined,
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Find the row ~1 year before `rows[atIndex]`, within the tolerance band.
 * Searches backward since `rows` is sorted ascending — the moment a candidate
 * is further back than the tolerance allows, every earlier row is too.
 */
export function findYoyPriorRow<T extends { date: Date }>(rows: T[], atIndex: number): T | null {
  const anchor = rows[atIndex];
  if (anchor === undefined) return null;

  for (let i = atIndex - 1; i >= 0; i--) {
    const candidate = rows[i]!;
    const diffDays = (anchor.date.getTime() - candidate.date.getTime()) / MS_PER_DAY;
    if (diffDays > YOY_TOLERANCE_DAYS_MAX) return null;
    if (diffDays >= YOY_TOLERANCE_DAYS_MIN) return candidate;
  }
  return null;
}

/**
 * Compute YoY revenue growth from a raw quarterly financials response.
 *
 * Exported for direct unit testing, same pattern as `computePctChange` in
 * `sector-trend.ts`. Revenue DECLINE is a real, reportable result — only a
 * missing/zero prior quarter is `"insufficient_data"`.
 */
export function computeRevenueGrowth(
  ticker: string,
  rows: QuarterlyFinancialsRow[],
): RevenueGrowthResult {
  const usable = usableRevenueRows(rows);

  if (usable.length === 0) {
    return { ticker, latestQuarterEnd: null, revenueGrowthPct: null, basis: "insufficient_data" };
  }

  const latestIndex = usable.length - 1;
  const latest = usable[latestIndex]!;
  const prior = findYoyPriorRow(usable, latestIndex);

  if (prior === null || prior.totalRevenue <= 0) {
    return {
      ticker,
      latestQuarterEnd: latest.date.toISOString().slice(0, 10),
      revenueGrowthPct: null,
      basis: "insufficient_data",
    };
  }

  const revenueGrowthPct = ((latest.totalRevenue - prior.totalRevenue) / prior.totalRevenue) * 100;

  return {
    ticker,
    latestQuarterEnd: latest.date.toISOString().slice(0, 10),
    revenueGrowthPct,
    basis: "yoy_quarterly",
  };
}

/**
 * READS  `tickers`
 * WRITES `revenueGrowth`, `growthCheckErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Never throws. A fetch failure or missing coverage degrades into
 * `growthCheckErrors` plus an `insufficient_data` result rather than crashing
 * the graph (§8).
 */
export async function revenueGrowthNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const growthCheckErrors = [...state.growthCheckErrors];
  const ticker = state.tickers[0];

  if (ticker === undefined) {
    growthCheckErrors.push("growth-authenticity: no ticker to analyse.");
    return { revenueGrowth: null, growthCheckErrors };
  }

  emitProgress(config, "revenue_growth", `Checking ${ticker}'s revenue growth...`);

  if (state.tickers.length > 1) {
    growthCheckErrors.push(
      `growth-authenticity: single-ticker capability — analysing ${ticker} only, ` +
        `skipped ${state.tickers.slice(1).join(", ")}.`,
    );
  }

  let rows: QuarterlyFinancialsRow[];
  try {
    rows = await fetchQuarterlyFinancials(ticker, now);
  } catch (error) {
    growthCheckErrors.push(
      `${ticker}: quarterly financials unavailable — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      revenueGrowth: {
        ticker,
        latestQuarterEnd: null,
        revenueGrowthPct: null,
        basis: "insufficient_data",
      },
      growthCheckErrors,
    };
  }

  const result = computeRevenueGrowth(ticker, rows);
  if (result.basis === "insufficient_data") {
    growthCheckErrors.push(
      `${ticker}: insufficient quarterly revenue history for a YoY comparison ` +
        `(${rows.length} rows returned).`,
    );
  }

  return { revenueGrowth: result, growthCheckErrors };
}
