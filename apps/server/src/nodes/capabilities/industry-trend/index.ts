/**
 * =============================================================================
 * Capability manifest: industry-trend
 * =============================================================================
 *
 * CLAUDE.md §3 requires each capability's `index.ts` to document, in comments,
 * which `AgentState` fields it reads and writes. That contract is what makes
 * the plugin architecture safe to extend: §4's extension rule says two
 * capabilities must NEVER write the same state field, and this file is where
 * that claim is staked and can be checked at review time.
 *
 * CAPABILITY ID
 * -------------
 * `"industry_trend"` — the string the supervisor pushes into
 * `state.activeCapabilities`, and the value `graph.ts` routes on. It is
 * exported as a constant below so no file has to spell the literal by hand.
 *
 * ┌─ STATE CONTRACT ──────────────────────────────────────────────────────────┐
 * │                                                                           │
 * │ READS (set upstream by the supervisor; never modified here)               │
 * │   timeWindow          the lookback period, e.g. "1mo"                     │
 * │   sectors             optional user-named sector(s); always ranked as     │
 * │                       part of all 11, but also FORCED into the leader     │
 * │                       breakdown (sector-leaders.ts) even if not one of    │
 * │                       the period's top/bottom N movers. Empty means no    │
 * │                       sector was named — leaders stay top/bottom-N-only.  │
 * │   activeCapabilities  used only by graph.ts to decide whether we run      │
 * │                                                                           │
 * │ WRITES (owned exclusively by this capability)                             │
 * │   sectorRankings      sector-trend.ts   — all 11 sectors, ranked          │
 * │   sectorLeaders       sector-leaders.ts — per-sector leader lists         │
 * │   trendDataErrors     both nodes        — non-fatal degradation notes     │
 * │   partialHoldingsSectors  sector-leaders.ts — sectors whose weight data   │
 * │                       came from Yahoo's top-10 fallback, not Alpha        │
 * │                       Vantage's full list; report-writer.ts reads this    │
 * │                       to decide whether a requested sector's data is      │
 * │                       good enough to narrate                             │
 * │                                                                           │
 * │ MUST NEVER TOUCH                                                          │
 * │   draftReport, finalReport, validationPassed, validationNotes,            │
 * │   retryCount          owned by report-writer.ts / validator.ts            │
 * │   messages            owned by the report writer and the API layer        │
 * │   tickers, intent     owned by the supervisor                             │
 * │   dataErrors          reserved for problems not attributable to one       │
 * │                       capability; this capability uses trendDataErrors    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * EXECUTION ORDER
 * ---------------
 * `sectorTrendNode` → `sectorLeadersNode`, strictly. The second reads
 * `sectorRankings` to decide which sectors deserve a leader breakdown, so
 * running them in parallel would leave it with `null`. `graph.ts` wires them
 * as a sequential pair for this reason.
 *
 * THE RULE THIS CAPABILITY EXISTS TO UPHOLD
 * -----------------------------------------
 * Both nodes are pure deterministic TypeScript — no LLM, ever (§1, §9). Every
 * number that reaches the report writer was computed here, by code you can
 * read and test. The report writer decides how to NARRATE the weight/speed
 * combination; it never decides what the numbers are.
 */

export const INDUSTRY_TREND_CAPABILITY_ID = "industry_trend";

export { sectorTrendNode } from "./sector-trend.js";
export { sectorLeadersNode } from "./sector-leaders.js";
