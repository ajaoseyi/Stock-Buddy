/**
 * =============================================================================
 * calibrate-growth-authenticity.ts — RUN MANUALLY, NEVER FROM THE TEST SUITE.
 * =============================================================================
 *
 * Same category as `tests/fixtures/capture.mjs` (a manual, real-API script,
 * not part of the build or the app), but this one drives the ACTUAL shipped
 * node pipeline instead of just saving raw responses — the point is to see
 * what `ROBUST_Z_THRESHOLD`/`MIN_BASELINE_QUARTERS` (stats.ts) actually
 * produce on real companies before trusting them, per CLAUDE.md §5.8/§5.9's
 * convention of verifying a threshold against live data before documenting it.
 *
 * Runs the real node functions in the exact sequence graph.ts wires them —
 * this is evidence about the shipped code path, not a re-implementation of it.
 *
 *     npx tsx scripts/calibrate-growth-authenticity.ts APA
 *     npx tsx scripts/calibrate-growth-authenticity.ts COST
 */

import { AgentStateSchema, type AgentState } from "../src/state.js";
import { revenueGrowthNode } from "../src/nodes/capabilities/growth-authenticity/revenue-growth.js";
import { priceRevenueDiscrepancyNode } from "../src/nodes/capabilities/growth-authenticity/price-revenue-discrepancy.js";
import { inorganicSignalNode } from "../src/nodes/capabilities/growth-authenticity/inorganic-signal.js";
import { sectorBenchmarkNode } from "../src/nodes/capabilities/growth-authenticity/sector-benchmark.js";
import { growthClassificationNode } from "../src/nodes/capabilities/growth-authenticity/growth-classification.js";
import {
  ROBUST_Z_THRESHOLD,
  MIN_BASELINE_QUARTERS,
} from "../src/nodes/capabilities/growth-authenticity/stats.js";

async function calibrate(ticker: string): Promise<void> {
  console.log(`\n${"=".repeat(70)}\n${ticker}\n${"=".repeat(70)}`);

  let state: AgentState = AgentStateSchema.parse({
    messages: [],
    tickers: [ticker],
    intent: "single_report",
    timeWindow: "1y",
    activeCapabilities: ["growth_authenticity"],
  }) as AgentState;

  const now = new Date();

  state = { ...state, ...(await revenueGrowthNode(state, now)) };
  console.log("\n-- revenueGrowth --");
  console.log(state.revenueGrowth);

  state = { ...state, ...(await priceRevenueDiscrepancyNode(state, now)) };
  console.log("\n-- priceRevenueDiscrepancy --");
  console.log(state.priceRevenueDiscrepancy);

  state = { ...state, ...(await inorganicSignalNode(state, now)) };
  console.log("\n-- inorganicSignal --");
  console.log(JSON.stringify(state.inorganicSignal, null, 2));

  state = { ...state, ...(await sectorBenchmarkNode(state, now)) };
  console.log("\n-- sectorBenchmark --");
  console.log(state.sectorBenchmark);

  state = { ...state, ...(await growthClassificationNode(state)) };
  console.log("\n-- CLASSIFICATION --");
  console.log(state.growthAuthenticity?.classification);
  console.log(state.growthAuthenticity?.classificationReasonCodes);

  if (state.growthCheckErrors.length > 0) {
    console.log("\n-- growthCheckErrors --");
    for (const e of state.growthCheckErrors) console.log(`  - ${e}`);
  }
}

async function main(): Promise<void> {
  console.log(
    `Calibrating with ROBUST_Z_THRESHOLD=${ROBUST_Z_THRESHOLD}, MIN_BASELINE_QUARTERS=${MIN_BASELINE_QUARTERS}`,
  );

  const tickers = process.argv.slice(2);
  if (tickers.length === 0) {
    console.error("Usage: npx tsx scripts/calibrate-growth-authenticity.ts TICKER [TICKER...]");
    process.exit(1);
  }

  for (const ticker of tickers) {
    await calibrate(ticker.toUpperCase());
  }
}

await main();
