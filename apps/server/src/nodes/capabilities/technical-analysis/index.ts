/**
 * =============================================================================
 * Capability manifest: technical-analysis
 * =============================================================================
 *
 * CLAUDE.md §3's per-capability contract, same convention as the other four
 * capability folders' `index.ts`.
 *
 * WHY THIS CAPABILITY EXISTS
 * --------------------------
 * Given a ticker, a few tickers, or a sector, produce a deterministic
 * technical-analysis trading-strategy suggestion — entry, stop-loss, and
 * take-profit price levels — with every number traceable to code, never an
 * LLM guess (CLAUDE.md §14.1). No other capability produces literal price
 * levels a user could act on, which is why the validator (§14.13) adds
 * dedicated dollar-figure verification on top of the checks every other
 * capability already gets.
 *
 * CAPABILITY ID
 * -------------
 * `"technical_analysis"` — pushed into `state.activeCapabilities` by
 * `supervisor.ts` when `intent === "technical_analysis"`.
 *
 * ┌─ STATE CONTRACT ──────────────────────────────────────────────────────────┐
 * │                                                                           │
 * │ READS (set upstream by the supervisor; never modified here)               │
 * │   tickers             priority target list, up to the ticker cap         │
 * │   sectors             used only when no ticker was named — resolved to   │
 * │                       that sector's ETF                                  │
 * │   timeWindow          echoed into each TechnicalAnalysisResult; NOT what  │
 * │                       drives indicator lookback (see constants.ts)       │
 * │   activeCapabilities  used only by graph.ts to decide whether we run      │
 * │                                                                           │
 * │ WRITES (owned exclusively by this capability)                             │
 * │   technicalAnalysis       technical-analysis-scan.ts (the only graph node)│
 * │   technicalAnalysisErrors same                                            │
 * │                                                                           │
 * │ MUST NEVER TOUCH                                                          │
 * │   any other capability's fields — growthAuthenticity, companySnapshots,   │
 * │   sectorRankings/sectorLeaders, portfolioGrowthResults, tickerComparison  │
 * │   draftReport, finalReport, validationPassed, validationNotes,            │
 * │     retryCount        owned by report-writer.ts / validator.ts           │
 * │   messages, tickers, sectors, intent   owned by report-writer / supervisor│
 * │   dataErrors          reserved for problems not attributable to one       │
 * │                       capability; this capability uses                   │
 * │                       technicalAnalysisErrors                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * EXECUTION SHAPE
 * ----------------
 * ONE graph node, `technicalAnalysisScanNode`, looping over up to
 * `TECHNICAL_ANALYSIS_TICKER_CAP` resolved targets and driving five plain
 * compute functions per target — see `technical-analysis-scan.ts` for why
 * this is one node rather than a chain (mirrors CLAUDE.md §13.7's reasoning).
 *
 * DATA SOURCE
 * -----------
 * Yahoo daily OHLCV ONLY, already fetched/cached by the industry-trend
 * capability's own tools (`fetchConstituentOhlcv`/`fetchSectorEtfHistory`).
 * Zero new external calls, zero Alpha Vantage spend.
 *
 * SCOPE
 * -----
 * A ticker, a few tickers (`TECHNICAL_ANALYSIS_TICKER_CAP = 5`), or a sector
 * (resolved to its ETF). Never blends weight/speed-style independent signals
 * into one score (CLAUDE.md §9) — `atrLevels`/`swingLevels` stay two
 * permanently separate objects, and `volatilityLevel` never feeds the stance
 * decision table.
 */

export const TECHNICAL_ANALYSIS_CAPABILITY_ID = "technical_analysis";

export { technicalAnalysisScanNode } from "./technical-analysis-scan.js";
export { resolveTechnicalAnalysisTargets, type ResolvedTarget } from "./resolve-targets.js";
export { computeIndicatorSnapshot } from "./indicator-snapshot.js";
export { computeMomentumDirection, computeTrendDirection, computeVolatilityLevel } from "./market-context.js";
export { computeSupportResistance } from "./support-resistance.js";
export { classifyTechnicalStance } from "./stance-classification.js";
export { computeAtrTradeLevels } from "./trade-levels-atr.js";
export {
  computeSwingTradeLevels,
  selectNearestSwingPoint,
  selectNextLevel,
} from "./trade-levels-swing.js";
export { TECHNICAL_ANALYSIS_TICKER_CAP } from "./constants.js";
