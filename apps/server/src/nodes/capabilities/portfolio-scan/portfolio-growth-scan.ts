/**
 * =============================================================================
 * portfolio-growth-scan.ts — growth-authenticity classification for each of N
 * tickers. DETERMINISTIC ORCHESTRATION, not a new analytical algorithm.
 * =============================================================================
 *
 * The only node in this capability (see ./index.ts). No LLM, ever (§1, §9).
 *
 * HOW REUSE ACTUALLY WORKS HERE
 * ------------------------------
 * `analyseOneTicker` drives the five existing growth-authenticity node
 * functions — `revenueGrowthNode`, `priceRevenueDiscrepancyNode`,
 * `inorganicSignalNode`, `sectorBenchmarkNode`, `growthClassificationNode` —
 * in the exact order `graph.ts` already wires them for a single ticker,
 * against a SYNTHETIC per-ticker state slice built from the real state but
 * with `tickers` narrowed to one and the four intermediate growth-authenticity
 * fields reset to `null` so one ticker's data can never leak into another's
 * classification. Each node's returned partial state is folded into the slice
 * before the next node runs — precisely what the graph's edges do, just
 * driven by a plain loop instead of graph execution (CLAUDE.md §12.3).
 *
 * None of the five files under `../growth-authenticity/` are modified. Every
 * §11.9 calibration finding (insufficient-history handling, goodwill's real
 * unavailability, etc.) carries over unchanged.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, GrowthAuthenticityResult } from "../../../state.js";
import { emitProgress } from "../../../streaming.js";
import { revenueGrowthNode } from "../growth-authenticity/revenue-growth.js";
import { priceRevenueDiscrepancyNode } from "../growth-authenticity/price-revenue-discrepancy.js";
import { inorganicSignalNode } from "../growth-authenticity/inorganic-signal.js";
import { sectorBenchmarkNode } from "../growth-authenticity/sector-benchmark.js";
import { growthClassificationNode } from "../growth-authenticity/growth-classification.js";

/**
 * Bounded per CLAUDE.md §12.2: the Alpha Vantage cross-check inside
 * `sectorBenchmarkNode` spends one call per analysed ticker's sector against
 * a 25/day budget (§11.2), so this is enough for a real "check my watchlist"
 * question without being able to exhaust the day's quota in one request.
 */
export const PORTFOLIO_SCAN_TICKER_CAP = 5;

/**
 * Run the full growth-authenticity chain for ONE ticker against a synthetic
 * state slice, entirely outside the graph's own state channels.
 *
 * Sequential internally too (each node awaited before the next), matching
 * `graph.ts`'s strictly-sequential wiring for the same five nodes.
 */
async function analyseOneTicker(
  ticker: string,
  state: AgentState,
  now: Date,
  config?: LangGraphRunnableConfig,
): Promise<{ result: GrowthAuthenticityResult | null; errors: string[] }> {
  let slice: AgentState = {
    ...state,
    tickers: [ticker],
    revenueGrowth: null,
    priceRevenueDiscrepancy: null,
    inorganicSignal: null,
    sectorBenchmark: null,
    growthAuthenticity: null,
    growthCheckErrors: [],
  };

  slice = { ...slice, ...(await revenueGrowthNode(slice, now, config)) };
  slice = { ...slice, ...(await priceRevenueDiscrepancyNode(slice, now, config)) };
  slice = { ...slice, ...(await inorganicSignalNode(slice, now, config)) };
  slice = { ...slice, ...(await sectorBenchmarkNode(slice, now, config)) };
  slice = { ...slice, ...(await growthClassificationNode(slice, config)) };

  return { result: slice.growthAuthenticity, errors: slice.growthCheckErrors };
}

/**
 * READS  `tickers`, `timeWindow`
 * WRITES `portfolioGrowthResults`, `portfolioScanErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Never throws for a per-ticker data problem — each ticker degrades
 * independently via the same `growthCheckErrors`-collecting mechanism §11's
 * nodes already use (§8: a tool-layer failure must not crash a graph run). A
 * ticker resolving to `insufficient_data`/`not_computable` still gets a real,
 * honestly-labelled entry in `portfolioGrowthResults` (§12.7) — it is never
 * dropped, and it never blocks the other tickers in the same batch.
 */
export async function portfolioGrowthScanNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const portfolioScanErrors: string[] = [];

  if (state.tickers.length === 0) {
    portfolioScanErrors.push("portfolio-scan: no tickers named — nothing to analyse.");
    return { portfolioGrowthResults: [], portfolioScanErrors };
  }

  const analysed = state.tickers.slice(0, PORTFOLIO_SCAN_TICKER_CAP);
  const skipped = state.tickers.slice(PORTFOLIO_SCAN_TICKER_CAP);
  if (skipped.length > 0) {
    portfolioScanErrors.push(
      `portfolio-scan: analysing the first ${PORTFOLIO_SCAN_TICKER_CAP} tickers only — ` +
        `skipped ${skipped.join(", ")}.`,
    );
  }

  const portfolioGrowthResults: GrowthAuthenticityResult[] = [];
  for (const ticker of analysed) {
    emitProgress(config, "portfolio_growth_scan", `Checking ${ticker}'s growth authenticity...`);

    const { result, errors } = await analyseOneTicker(ticker, state, now, config);
    portfolioScanErrors.push(...errors);

    if (result !== null) {
      portfolioGrowthResults.push(result);
    } else {
      // Defensive only: every node in the chain degrades into an
      // `insufficient_data`-flavoured result rather than `null` once a real
      // ticker is supplied (which this loop always does) — see the state
      // contract's READS note. This branch guards the invariant, not a
      // reachable-in-practice case.
      portfolioScanErrors.push(`${ticker}: growth-authenticity check could not be completed.`);
    }
  }

  return { portfolioGrowthResults, portfolioScanErrors };
}
