/**
 * =============================================================================
 * Capability manifest: company-snapshot
 * =============================================================================
 *
 * CLAUDE.md §3's per-capability contract, same convention as
 * `industry-trend/index.ts` and `growth-authenticity/index.ts`.
 *
 * WHY THIS CAPABILITY EXISTS
 * --------------------------
 * §11 (growth-authenticity) answers one narrow question — "is this ticker's
 * growth real" — for one ticker. This capability answers a much broader class
 * of question about one ticker (or a small handful): "how is NVDA valued
 * against its peers", "is AAPL's balance sheet healthy", "give me NVDA's key
 * stats". It is a SEPARATE intent/capability from `single_report`, not a
 * broadening of it, so an ordinary growth-authenticity question never pays
 * this capability's extra API cost (CLAUDE.md §13.1).
 *
 * CAPABILITY ID
 * -------------
 * `"company_snapshot"` — pushed into `state.activeCapabilities` by
 * `supervisor.ts` when `intent === "company_snapshot"`.
 *
 * ┌─ STATE CONTRACT ──────────────────────────────────────────────────────────┐
 * │                                                                           │
 * │ READS (set upstream by the supervisor; never modified here)               │
 * │   tickers             up to COMPANY_SNAPSHOT_TICKER_CAP are analysed      │
 * │   timeWindow          echoed into each CompanySnapshotResult              │
 * │   activeCapabilities  used only by graph.ts to decide whether we run      │
 * │                                                                           │
 * │ WRITES (owned exclusively by this capability)                             │
 * │   companySnapshots       company-snapshot-scan.ts (the only graph node)   │
 * │   companySnapshotErrors  same                                             │
 * │                                                                           │
 * │ MUST NEVER TOUCH                                                          │
 * │   tickerComparison, portfolioGrowthResults, portfolioScanErrors — owned   │
 * │     by the portfolio-scan capability, even though `ticker-comparison.ts`  │
 * │     there imports this folder's compute functions directly (§12.8)       │
 * │   revenueGrowth, growthAuthenticity, etc. — owned by growth-authenticity  │
 * │   sectorRankings, sectorLeaders, trendDataErrors — owned by industry-trend│
 * │   draftReport, finalReport, validationPassed, validationNotes,            │
 * │     retryCount        owned by report-writer.ts / validator.ts           │
 * │   messages, tickers, intent   owned by the report writer / supervisor     │
 * │   dataErrors          reserved for problems not attributable to one       │
 * │                       capability; this capability uses companySnapshotErrors │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * EXECUTION SHAPE
 * ----------------
 * ONE graph node, `companySnapshotScanNode`, which loops over up to
 * `COMPANY_SNAPSHOT_TICKER_CAP` tickers and drives three plain compute
 * functions per ticker (`computeCompanyProfile`, `computeValuationMetrics`,
 * `computeFinancialHealth`) — see `company-snapshot-scan.ts` for why this is
 * one node rather than a chain (§13.7). The three compute functions are
 * re-exported below so `ticker-comparison.ts`, in the SEPARATE
 * `portfolio-scan` capability folder, can call them directly when 2+ tickers
 * are compared (§12.8) — the one deliberate cross-capability function reuse
 * in this codebase, mirroring how `portfolio-growth-scan.ts` already reuses
 * growth-authenticity's five node functions.
 *
 * SCOPE
 * -----
 * A ticker or a small handful (`COMPANY_SNAPSHOT_TICKER_CAP = 5`). Never
 * blends valuation/financial-health metrics into one score — CLAUDE.md §9,
 * unmodified by §9.1's carve-out, which applies only to §12.8's cross-ticker
 * verdict, not to a single company's own metrics.
 */

export const COMPANY_SNAPSHOT_CAPABILITY_ID = "company_snapshot";

export { companySnapshotScanNode, COMPANY_SNAPSHOT_TICKER_CAP } from "./company-snapshot-scan.js";
export { computeCompanyProfile } from "./company-profile.js";
export { computeValuationMetrics } from "./valuation-metrics.js";
export { computeFinancialHealth } from "./financial-health.js";
/**
 * Re-exported for the same reason as the three compute functions above:
 * `ticker-comparison.ts` (portfolio-scan capability, §12.8) needs the same
 * sector + peer-sample resolution this capability's own scan node uses.
 * Still not part of the report-writer/validator-facing surface — just a
 * second consumer of this data-layer function.
 */
export { resolvePeerSample } from "./peer-sample.js";
