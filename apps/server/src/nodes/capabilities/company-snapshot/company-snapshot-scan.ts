/**
 * =============================================================================
 * company-snapshot-scan.ts — build a company snapshot for each of N tickers.
 * DETERMINISTIC ORCHESTRATION, no LLM.
 * =============================================================================
 *
 * THE ONLY GRAPH NODE THIS CAPABILITY REGISTERS
 * ------------------------------------------------
 * Deliberate deviation from growth-authenticity's five-node chain — stated
 * explicitly so it is not mistaken for an inconsistency. Growth-authenticity
 * registers five separate nodes because those five ARE the real single-ticker
 * graph path for `single_report`. Company-snapshot has no such single-ticker
 * chain to begin with (§13.1 already scopes it to "a ticker or a small
 * handful"), so it needs the loop-over-tickers shape from day one — the same
 * shape `portfolio-growth-scan.ts` already uses for exactly that reason.
 * Building a 3-node chain here and then immediately wrapping it in a loop
 * (as `ticker-comparison.ts` would also need) would be pure indirection. So
 * `company-profile.ts`/`valuation-metrics.ts`/`financial-health.ts` are plain
 * functions, not nodes, and this file is the one real
 * `(state, now, config) => Promise<Partial<AgentState>>` node.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, CompanySnapshotResult } from "../../../state.js";
import { emitProgress } from "../../../streaming.js";
import { computeCompanyProfile } from "./company-profile.js";
import { computeValuationMetrics } from "./valuation-metrics.js";
import { computeFinancialHealth } from "./financial-health.js";
import { resolvePeerSample } from "./peer-sample.js";

/**
 * Own local constant, not shared with `PORTFOLIO_SCAN_TICKER_CAP` — same
 * value today, but capability-owned per CLAUDE.md §3's containment rule.
 */
export const COMPANY_SNAPSHOT_TICKER_CAP = 5;

/**
 * READS  `tickers`, `timeWindow`
 * WRITES `companySnapshots`, `companySnapshotErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Sequential over tickers (not `Promise.all`) — same rate-limit discipline
 * §12.3 already established for the analogous portfolio-scan loop. Within one
 * ticker, the peer sample is resolved once and reused by both compute
 * functions; the two compute functions themselves run sequentially rather
 * than concurrently for the same one-thing-at-a-time simplicity this
 * codebase already prefers (§13.7), even though there is no data dependency
 * between them.
 *
 * A per-ticker failure degrades that ticker's entry, never the whole batch —
 * §8's tool-layer-failure-must-not-crash-a-run rule, same invariant
 * `portfolio-growth-scan.ts` already establishes.
 */
export async function companySnapshotScanNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const companySnapshotErrors: string[] = [];

  if (state.tickers.length === 0) {
    companySnapshotErrors.push("company-snapshot: no tickers named — nothing to analyse.");
    return { companySnapshots: [], companySnapshotErrors };
  }

  const analysed = state.tickers.slice(0, COMPANY_SNAPSHOT_TICKER_CAP);
  const skipped = state.tickers.slice(COMPANY_SNAPSHOT_TICKER_CAP);
  if (skipped.length > 0) {
    companySnapshotErrors.push(
      `company-snapshot: analysing the first ${COMPANY_SNAPSHOT_TICKER_CAP} tickers only — ` +
        `skipped ${skipped.join(", ")}.`,
    );
  }

  const companySnapshots: CompanySnapshotResult[] = [];
  for (const ticker of analysed) {
    emitProgress(config, "company_snapshot_scan", `Building company snapshot for ${ticker}...`);

    const peerSample = await resolvePeerSample(ticker, now);
    const { result: profile, errors: profileErrors } = await computeCompanyProfile(ticker, now);
    const { result: valuation, errors: valuationErrors } = await computeValuationMetrics(
      ticker,
      peerSample.sector,
      peerSample.peers,
      now,
    );
    const { result: financialHealth, errors: healthErrors } = await computeFinancialHealth(
      ticker,
      peerSample.sector,
      peerSample.peers,
      now,
    );

    companySnapshotErrors.push(...peerSample.errors, ...profileErrors, ...valuationErrors, ...healthErrors);

    companySnapshots.push({
      ticker,
      timeWindow: state.timeWindow,
      profile,
      valuation,
      financialHealth,
    });
  }

  return { companySnapshots, companySnapshotErrors };
}
