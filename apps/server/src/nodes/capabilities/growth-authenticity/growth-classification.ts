/**
 * =============================================================================
 * growth-classification.ts — assemble the final verdict. DETERMINISTIC.
 * =============================================================================
 *
 * Fifth and last node in the growth-authenticity pipeline (see ./index.ts).
 * No LLM, ever (§1, §9).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONE RULE THIS FILE EXISTS TO ENFORCE                                  │
 * │                                                                           │
 * │ `classifyGrowthAuthenticity` below is a fixed decision table over THREE   │
 * │ CATEGORICAL FLAGS. There is no line in this file that adds, multiplies,   │
 * │ or averages the underlying numbers. Mirrors `classifyQuadrant` in         │
 * │ `sector-leaders.ts` exactly: the only thing produced is a LABEL.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * MUST run after the other four nodes, which populate `revenueGrowth`,
 * `priceRevenueDiscrepancy`, `inorganicSignal`, `sectorBenchmark`.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type {
  AgentState,
  DiscrepancyResult,
  GrowthAuthenticityResult,
  InorganicSignalResult,
  SectorBenchmarkResult,
} from "../../../state.js";
import { emitProgress } from "../../../streaming.js";

/**
 * Reduce the three upstream categorical flags to one classification.
 *
 * Exported for direct unit testing — this is the most important single
 * function in the capability, by direct analogy to how `sector-leaders.ts`
 * calls out its quadrant test as the most important assertion in that file.
 *
 * Order of checks matters and is deliberate:
 *   1. All-unknown → `insufficient_data`. Nothing else can be claimed.
 *      `"insufficient_history"` counts as unknown here alongside
 *      `"not_computable"` — per live calibration (CLAUDE.md §11.9) it is the
 *      COMMON case for the ratio baseline, not a rare edge case, so it must
 *      not silently read as "resolved, and aligned" (see state.ts's
 *      `DiscrepancyResultSchema` comment for the live-data incident this
 *      fixed).
 *   2. `likely_ma_driven` wins outright — a detected M&A signal explains the
 *      move regardless of what the price/revenue ratio or sector spread say,
 *      because those two are themselves consequences of the acquisition.
 *   3. `beta_explained`, PROVIDED the discrepancy isn't itself
 *      `revenue_outpacing_price` — a stock whose fundamentals are outrunning
 *      its price is not usefully described as "just sector beta" even if its
 *      price also happens to track the sector. Firing even when the ratio is
 *      `insufficient_history` is intentional — the sector comparison is
 *      evidence on its own, independent of whether the ratio baseline
 *      resolved.
 *   4. `price_outpacing_revenue` + `stock_specific_move` together is the
 *      unexplained case — the executable form of the "illusion of growth"
 *      this whole capability exists to catch: price decoupled from revenue,
 *      AND not explained by the sector.
 *   5. `aligned` or `revenue_outpacing_price` → organic growth is supported.
 *      Deliberately NOT `insufficient_history` — "supported" is an
 *      affirmative claim the missing-baseline case cannot make.
 *   6. Anything else (including `insufficient_history` with no M&A signal and
 *      no sector explanation) → `mixed_signals`, an honest "the evidence
 *      doesn't point one way" rather than forcing a confident label.
 */
export function classifyGrowthAuthenticity(
  discrepancyFlag: DiscrepancyResult["discrepancyFlag"],
  inorganicSignal: InorganicSignalResult["inorganicSignal"],
  macroBetaFlag: SectorBenchmarkResult["macroBetaFlag"],
): { classification: GrowthAuthenticityResult["classification"]; reasonCodes: string[] } {
  const reasonCodes = [
    `discrepancy:${discrepancyFlag}`,
    `inorganic_signal:${inorganicSignal}`,
    `macro_beta:${macroBetaFlag}`,
  ];

  const allUnknown =
    (discrepancyFlag === "not_computable" || discrepancyFlag === "insufficient_history") &&
    inorganicSignal === "insufficient_data" &&
    macroBetaFlag === "not_computable";
  if (allUnknown) return { classification: "insufficient_data", reasonCodes };

  if (inorganicSignal === "likely_ma_driven") {
    return { classification: "inorganic_ma_driven", reasonCodes };
  }

  if (macroBetaFlag === "beta_explained" && discrepancyFlag !== "revenue_outpacing_price") {
    return { classification: "macro_or_commodity_beta_driven", reasonCodes };
  }

  if (discrepancyFlag === "price_outpacing_revenue" && macroBetaFlag === "stock_specific_move") {
    return { classification: "price_outpacing_fundamentals_unexplained", reasonCodes };
  }

  if (discrepancyFlag === "aligned" || discrepancyFlag === "revenue_outpacing_price") {
    return { classification: "organic_growth_supported", reasonCodes };
  }

  return { classification: "mixed_signals", reasonCodes };
}

/**
 * READS  `tickers`, `timeWindow`, `revenueGrowth`, `priceRevenueDiscrepancy`,
 *        `inorganicSignal`, `sectorBenchmark`
 * WRITES `growthAuthenticity`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Degrades gracefully: only falls back to `insufficient_data` at the assembled
 * level via `classifyGrowthAuthenticity`'s own all-unknown check — a partial
 * result (e.g. balance-sheet fetch failed but price/revenue and sector data
 * are fine) still produces a real classification, with the gap already
 * recorded in `growthCheckErrors` by the node that hit it.
 *
 * `async` for signature consistency with the other four nodes (and whatever
 * the installed LangGraph version expects), even though nothing here awaits —
 * this node does no I/O of its own, only assembly.
 */
export function growthClassificationNode(
  state: AgentState,
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const ticker = state.tickers[0];

  if (ticker !== undefined) {
    emitProgress(config, "growth_classification", `Classifying ${ticker}'s growth authenticity...`);
  }

  if (
    ticker === undefined ||
    state.revenueGrowth === null ||
    state.priceRevenueDiscrepancy === null ||
    state.inorganicSignal === null ||
    state.sectorBenchmark === null
  ) {
    return Promise.resolve({ growthAuthenticity: null });
  }

  const { classification, reasonCodes } = classifyGrowthAuthenticity(
    state.priceRevenueDiscrepancy.discrepancyFlag,
    state.inorganicSignal.inorganicSignal,
    state.sectorBenchmark.macroBetaFlag,
  );

  const growthAuthenticity: GrowthAuthenticityResult = {
    ticker,
    timeWindow: state.timeWindow,
    revenueGrowth: state.revenueGrowth,
    discrepancy: state.priceRevenueDiscrepancy,
    inorganic: state.inorganicSignal,
    sectorBenchmark: state.sectorBenchmark,
    classification,
    classificationReasonCodes: reasonCodes,
  };

  return Promise.resolve({ growthAuthenticity });
}
