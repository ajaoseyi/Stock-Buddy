/**
 * =============================================================================
 * Capability manifest: growth-authenticity
 * =============================================================================
 *
 * CLAUDE.md §3's per-capability contract, same convention as
 * `industry-trend/index.ts`.
 *
 * WHY THIS CAPABILITY EXISTS
 * --------------------------
 * A stock price rallying is not the same claim as a business growing. This
 * capability separates the two: it computes, deterministically, whether a
 * ticker's price move over `timeWindow` is backed by real revenue growth, is
 * an artefact of M&A (goodwill/PP&E jumping while cash drains), is just the
 * ticker's sector/commodity beta, or is unexplained by any of the above.
 *
 * CAPABILITY ID
 * -------------
 * `"growth_authenticity"` — pushed into `state.activeCapabilities` by
 * `supervisor.ts` when `intent === "single_report"`.
 *
 * ┌─ STATE CONTRACT ──────────────────────────────────────────────────────────┐
 * │                                                                           │
 * │ READS (set upstream by the supervisor; never modified here)               │
 * │   tickers             single-ticker scope: only tickers[0] is analysed    │
 * │   timeWindow          the lookback period, e.g. "1y"                      │
 * │   activeCapabilities  used only by graph.ts to decide whether we run      │
 * │                                                                           │
 * │ WRITES (owned exclusively by this capability, one field per node)         │
 * │   revenueGrowth            revenue-growth.ts                              │
 * │   priceRevenueDiscrepancy  price-revenue-discrepancy.ts                   │
 * │   inorganicSignal          inorganic-signal.ts                            │
 * │   sectorBenchmark          sector-benchmark.ts                            │
 * │   growthAuthenticity       growth-classification.ts (assembled result)    │
 * │   growthCheckErrors        all five nodes append                          │
 * │                                                                           │
 * │ MUST NEVER TOUCH                                                          │
 * │   sectorRankings, sectorLeaders, trendDataErrors — owned by industry-trend│
 * │   draftReport, finalReport, validationPassed, validationNotes,            │
 * │   retryCount          owned by report-writer.ts / validator.ts            │
 * │   messages, tickers, intent   owned by the report writer / supervisor     │
 * │   dataErrors          reserved for problems not attributable to one       │
 * │                       capability; this capability uses growthCheckErrors  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * EXECUTION ORDER
 * ---------------
 * `revenueGrowthNode` → `priceRevenueDiscrepancyNode` → `inorganicSignalNode`
 * → `sectorBenchmarkNode` → `growthClassificationNode`, strictly. Each of the
 * first four owns exactly one state field and never shares it — this
 * project's zod-object state fields use an OVERWRITE reducer, not a deep
 * merge, so two nodes writing the same field would let the second silently
 * erase the first's work. The fifth node reads all four and assembles the
 * public result.
 *
 * SCOPE
 * -----
 * Single ticker only (`tickers[0]`). No sector ranking, no portfolio scan.
 * Produces a deterministic classification of WHY a stock moved over
 * `timeWindow`, plus the disaggregated evidence behind it — never a blended
 * "authenticity score" (CLAUDE.md §5.4/§9's anti-blending rule, applied here
 * to price/revenue/goodwill/PP&E/sector-spread instead of weight/speed).
 *
 * THE RULE THIS CAPABILITY EXISTS TO UPHOLD
 * ------------------------------------------
 * All five nodes are pure deterministic TypeScript — no LLM, ever (§1, §9).
 * The report writer NARRATES `classification`; it never computes or overrides
 * it, and `validator.ts` enforces that the draft report's prose actually
 * states the computed classification rather than drifting from it.
 */

export const GROWTH_AUTHENTICITY_CAPABILITY_ID = "growth_authenticity";

export { revenueGrowthNode } from "./revenue-growth.js";
export { priceRevenueDiscrepancyNode } from "./price-revenue-discrepancy.js";
export { inorganicSignalNode } from "./inorganic-signal.js";
export { sectorBenchmarkNode } from "./sector-benchmark.js";
export { growthClassificationNode } from "./growth-classification.js";
