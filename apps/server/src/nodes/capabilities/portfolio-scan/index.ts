/**
 * =============================================================================
 * Capability manifest: portfolio-scan
 * =============================================================================
 *
 * CLAUDE.md §3's per-capability contract, same convention as
 * `industry-trend/index.ts` and `growth-authenticity/index.ts`.
 *
 * WHY THIS CAPABILITY EXISTS
 * --------------------------
 * §11 (growth-authenticity) answers "is this ONE stock's growth real" for a
 * single ticker. A user with several names in mind ("are AAPL, MSFT, and NVDA
 * all growing for real, or is this just the AI trade?") needs the same
 * question answered per ticker, side by side — never blended into one
 * portfolio-level score (CLAUDE.md §12.1, extending the anti-blending rule
 * §5.4/§9 already established for weight/speed to the multi-ticker case).
 *
 * CAPABILITY ID
 * -------------
 * `"portfolio_scan"` — pushed into `state.activeCapabilities` by
 * `supervisor.ts` when `intent === "portfolio_scan"` and at least one ticker
 * was named.
 *
 * ┌─ STATE CONTRACT ──────────────────────────────────────────────────────────┐
 * │                                                                           │
 * │ READS (set upstream by the supervisor; never modified here)               │
 * │   tickers             up to CLAUDE.md §12.2's cap are analysed            │
 * │   timeWindow          the lookback period, e.g. "1y"                      │
 * │   activeCapabilities  used only by graph.ts to decide whether we run      │
 * │                                                                           │
 * │ WRITES (owned exclusively by this capability)                             │
 * │   portfolioGrowthResults   portfolio-growth-scan.ts                       │
 * │   tickerComparison         ticker-comparison.ts (§12.8, 2+ tickers only)  │
 * │   portfolioScanErrors      both of the above append to this one field     │
 * │                                                                           │
 * │ MUST NEVER TOUCH                                                          │
 * │   revenueGrowth, priceRevenueDiscrepancy, inorganicSignal,                │
 * │   sectorBenchmark, growthAuthenticity, growthCheckErrors — owned          │
 * │                       exclusively by a `single_report` run (§11)          │
 * │   companySnapshots, companySnapshotErrors — owned by the company-snapshot │
 * │     capability, even though ticker-comparison.ts imports THAT folder's    │
 * │     compute functions directly (§12.8) — the reuse is code, not state     │
 * │   sectorRankings, sectorLeaders, trendDataErrors — owned by industry-trend│
 * │   draftReport, finalReport, validationPassed, validationNotes,            │
 * │   retryCount          owned by report-writer.ts / validator.ts            │
 * │   messages, tickers, intent   owned by the report writer / supervisor     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * NOT A NEW ALGORITHM
 * --------------------
 * `portfolioGrowthScanNode` is a single orchestration node, not a five-node
 * chain — it internally DRIVES the five existing, already-tested,
 * already-calibrated growth-authenticity node functions
 * (`nodes/capabilities/growth-authenticity/*.ts`, completely unmodified) once
 * per ticker, sequentially, entirely outside the LangGraph state-channel
 * mechanism (CLAUDE.md §12.3). Every §11.9 calibration finding — insufficient-
 * history handling, goodwill's real unavailability from this data source,
 * etc. — carries over unchanged, because the exact same functions run.
 *
 * `tickerComparisonNode` (§12.8) runs AFTER it, and is the ONE place CLAUDE.md
 * §9.1's narrow blending carve-out applies: a fixed rank-count decision table
 * over already-verified numbers, never an arithmetic blend. It drives the
 * SEPARATE company-snapshot capability's compute functions directly (imported
 * from `../company-snapshot/index.js`) — the one deliberate cross-capability
 * function reuse in this codebase, mirroring how this file's own node reuses
 * growth-authenticity's five functions.
 *
 * SCOPE
 * -----
 * Up to `PORTFOLIO_SCAN_TICKER_CAP` tickers (CLAUDE.md §12.2). Sequential, not
 * parallel, to respect §11.2's per-provider rate limits the same way a
 * concurrent multi-ticker fetch would risk violating.
 */

export const PORTFOLIO_SCAN_CAPABILITY_ID = "portfolio_scan";

export { portfolioGrowthScanNode, PORTFOLIO_SCAN_TICKER_CAP } from "./portfolio-growth-scan.js";
export { tickerComparisonNode, classifyTickerComparison, CLEAR_LEAD_THRESHOLD, COMPARISON_METRICS } from "./ticker-comparison.js";
