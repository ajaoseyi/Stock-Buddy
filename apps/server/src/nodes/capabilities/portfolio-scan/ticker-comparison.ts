/**
 * =============================================================================
 * ticker-comparison.ts — comparative verdict across 2+ compared tickers.
 * DETERMINISTIC. §12.8, §9.1.
 * =============================================================================
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * -------------------------------------------
 * `classifyTickerComparison` below is a fixed RANK-COUNT decision table, not
 * an arithmetic blend. It counts, per metric, which ticker had the more
 * favourable already-computed value, tallies those counts, and applies a
 * fixed margin rule. There is no line in this file that adds, multiplies, or
 * weights the underlying numeric VALUES into one score — see CLAUDE.md §9.1
 * for the exact boundary this file must not cross.
 *
 * WHERE THE COMPARISON DATA COMES FROM
 * ---------------------------------------
 * On top of the per-ticker `portfolioGrowthResults` `portfolio-growth-
 * scan.ts` already produces, this node ALSO drives company-snapshot's three
 * compute functions (`computeCompanyProfile`, `computeValuationMetrics`,
 * `computeFinancialHealth`, imported from the SEPARATE `company-snapshot`
 * capability folder — the one deliberate cross-capability function reuse in
 * this codebase, mirroring how `portfolio-growth-scan.ts` already reuses
 * growth-authenticity's five node functions) once per compared ticker.
 * Nothing computed here is written to `state.companySnapshots` — that field
 * stays exclusively owned by the `company_snapshot` capability (§4).
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type {
  AgentState,
  CompanyProfileFacts,
  FinancialHealthResult,
  GrowthAuthenticityResult,
  PeerRelativeMetric,
  TickerComparisonResult,
  TickerMetricRank,
  TickerOverallVerdict,
  ValuationMetricsResult,
} from "../../../state.js";
import { emitProgress } from "../../../streaming.js";
import {
  computeCompanyProfile,
  computeFinancialHealth,
  computeValuationMetrics,
  resolvePeerSample,
} from "../company-snapshot/index.js";

/**
 * The margin rule (§12.8 step 8): the leading ticker must have won more than
 * half of the comparable metrics more than the runner-up did. Fixed code
 * constant, reviewed the same way `QUADRANT_PERCENTILE`/`MIN_BASELINE_QUARTERS`
 * are (§9.1) — never inferred by the LLM or accepted as a request parameter.
 */
export const CLEAR_LEAD_THRESHOLD = 0.5;

/**
 * Relative tolerance for treating two metric values as tied rather than
 * forcing an arbitrary tiebreak (§12.8 step 3). Not yet live-calibrated —
 * see CLAUDE.md §12.9's placeholder.
 */
const TIE_RELATIVE_EPSILON = 1e-6;

interface CompanySnapshotLike {
  profile: CompanyProfileFacts | null;
  valuation: ValuationMetricsResult | null;
  financialHealth: FinancialHealthResult | null;
}

interface PerTickerData {
  growth: GrowthAuthenticityResult;
  snapshot: CompanySnapshotLike;
}

function findMetricValue(metrics: PeerRelativeMetric[] | undefined, name: string): number | null {
  return metrics?.find((m) => m.metric === name)?.value ?? null;
}

interface ComparisonMetricDef {
  metric: string;
  higherIsBetter: boolean;
  extract: (d: PerTickerData) => number | null;
}

/**
 * The 11 candidate comparison metrics (§12.8 step 1). Price change and the
 * price/revenue discrepancy are DELIBERATELY EXCLUDED — see CLAUDE.md §9.1's
 * rationale: rewarding whichever ticker's price already ran further would
 * quietly reintroduce the "mistaking a price rally for strength" failure mode
 * growth-authenticity (§11) exists to catch.
 */
export const COMPARISON_METRICS: ComparisonMetricDef[] = [
  { metric: "revenue_growth_pct", higherIsBetter: true, extract: (d) => d.growth.revenueGrowth.revenueGrowthPct },
  {
    metric: "trailing_pe",
    higherIsBetter: false,
    extract: (d) => findMetricValue(d.snapshot.valuation?.metrics, "trailing_pe"),
  },
  {
    metric: "forward_pe",
    higherIsBetter: false,
    extract: (d) => findMetricValue(d.snapshot.valuation?.metrics, "forward_pe"),
  },
  {
    metric: "price_to_book",
    higherIsBetter: false,
    extract: (d) => findMetricValue(d.snapshot.valuation?.metrics, "price_to_book"),
  },
  {
    metric: "ev_to_ebitda",
    higherIsBetter: false,
    extract: (d) => findMetricValue(d.snapshot.valuation?.metrics, "ev_to_ebitda"),
  },
  {
    metric: "debt_to_equity",
    higherIsBetter: false,
    extract: (d) => findMetricValue(d.snapshot.financialHealth?.metrics, "debt_to_equity"),
  },
  {
    metric: "current_ratio",
    higherIsBetter: true,
    extract: (d) => findMetricValue(d.snapshot.financialHealth?.metrics, "current_ratio"),
  },
  {
    metric: "return_on_equity",
    higherIsBetter: true,
    extract: (d) => findMetricValue(d.snapshot.financialHealth?.metrics, "return_on_equity"),
  },
  {
    metric: "return_on_assets",
    higherIsBetter: true,
    extract: (d) => findMetricValue(d.snapshot.financialHealth?.metrics, "return_on_assets"),
  },
  {
    metric: "profit_margin",
    higherIsBetter: true,
    extract: (d) => findMetricValue(d.snapshot.financialHealth?.metrics, "profit_margin"),
  },
  {
    metric: "fcf_margin",
    higherIsBetter: true,
    extract: (d) => findMetricValue(d.snapshot.financialHealth?.metrics, "fcf_margin"),
  },
];

/** Are `a` and `b` close enough to count as a tie, given the metric's own precision? */
function isTie(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= TIE_RELATIVE_EPSILON * scale;
}

/**
 * Reduce N tickers' data to one comparative verdict via a fixed rank-count
 * table over ALREADY-COMPUTED, ALREADY-VERIFIED numbers.
 *
 * Exported for direct unit testing — this is the most important single
 * function in this file, by direct analogy to `classifyGrowthAuthenticity`'s
 * own "most important single function in the capability" convention.
 *
 * Order of operations, mirroring CLAUDE.md §12.8 exactly:
 *   1. Build `metricRanks`: one entry per COMPARISON_METRICS definition, with
 *      every ticker's value and (if comparable) a winner.
 *   2. A metric is comparable only if every compared ticker has a non-null
 *      value — a missing value removes the metric from consideration rather
 *      than forcing a guess (the same "a missing signal is honest" principle
 *      as §5.9(b)/§11.9(b)).
 *   3. Per comparable metric, the ticker with the more favourable value (per
 *      `higherIsBetter`) gets a win; a tie within tolerance awards no win.
 *   4. Tally `winCounts`; `topCount`/`runnerUpCount` = the highest/
 *      second-highest tallies (by SORTED VALUE, so "the top spot is itself
 *      tied between two tickers" and "all metrics tied at 0 wins" both
 *      naturally collapse to `topCount === runnerUpCount`).
 *   5-9. Apply the verdict rule.
 */
export function classifyTickerComparison(
  tickers: string[],
  perTicker: Map<string, PerTickerData>,
): TickerComparisonResult {
  const metricRanks: TickerMetricRank[] = COMPARISON_METRICS.map(({ metric, higherIsBetter, extract }) => {
    const values = tickers.map((ticker) => {
      const data = perTicker.get(ticker);
      return { ticker, value: data === undefined ? null : extract(data) };
    });

    const comparable = values.every((v) => v.value !== null);
    let winner: string | null = null;

    if (comparable) {
      const numericValues = values as { ticker: string; value: number }[];
      const best = higherIsBetter
        ? Math.max(...numericValues.map((v) => v.value))
        : Math.min(...numericValues.map((v) => v.value));
      const atBest = numericValues.filter((v) => isTie(v.value, best));
      winner = atBest.length === 1 ? atBest[0]!.ticker : null;
    }

    return { metric, higherIsBetter, values, winner };
  });

  const winCounts: Record<string, number> = Object.fromEntries(tickers.map((t) => [t, 0]));
  let comparableMetricCount = 0;
  for (const rank of metricRanks) {
    const anyComparable = rank.values.every((v) => v.value !== null);
    if (anyComparable) comparableMetricCount += 1;
    if (rank.winner !== null) winCounts[rank.winner] = (winCounts[rank.winner] ?? 0) + 1;
  }

  const counts = tickers.map((t) => winCounts[t] ?? 0).sort((a, b) => b - a);
  const topCount = counts[0] ?? 0;
  const runnerUpCount = counts[1] ?? 0;

  let overallVerdict: TickerOverallVerdict;
  if (comparableMetricCount === 0) {
    overallVerdict = {
      verdict: "insufficient_comparable_data",
      strongerTicker: null,
      winCounts,
      comparableMetricCount,
    };
  } else if (topCount === runnerUpCount) {
    // Covers BOTH "every comparable metric tied" (topCount === 0) AND "the
    // top spot is itself tied between two or more tickers" — both collapse to
    // the same equality once counts are sorted (§12.8 steps 6-7).
    overallVerdict = { verdict: "no_clear_leader", strongerTicker: null, winCounts, comparableMetricCount };
  } else {
    const strongerTicker = tickers.find((t) => winCounts[t] === topCount) ?? null;
    const margin = (topCount - runnerUpCount) / comparableMetricCount;
    overallVerdict = {
      verdict: margin >= CLEAR_LEAD_THRESHOLD ? "clear_lead" : "narrow_lead",
      strongerTicker,
      winCounts,
      comparableMetricCount,
    };
  }

  return { tickers, metricRanks, overallVerdict };
}

/**
 * READS  `tickers`, `timeWindow`, `portfolioGrowthResults`
 * WRITES `tickerComparison`, `portfolioScanErrors` (appends)
 * NEVER TOUCHES `companySnapshots` — that field stays exclusively owned by
 * the `company_snapshot` capability (§4's never-share-a-field rule), even
 * though this node calls that capability's compute functions directly.
 *
 * With fewer than 2 tickers analysed, `tickerComparison` stays `null` —
 * nothing to compare (§12.8's trigger condition).
 */
export async function tickerComparisonNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const results = state.portfolioGrowthResults ?? [];

  if (state.tickers.length < 2 || results.length < 2) {
    return { tickerComparison: null };
  }

  const errors: string[] = [...state.portfolioScanErrors];
  const perTicker = new Map<string, PerTickerData>();

  for (const result of results) {
    emitProgress(config, "ticker_comparison", `Gathering comparison data for ${result.ticker}...`);

    const peerSample = await resolvePeerSample(result.ticker, now);
    const { result: profile, errors: profileErrors } = await computeCompanyProfile(result.ticker, now);
    const { result: valuation, errors: valuationErrors } = await computeValuationMetrics(
      result.ticker,
      peerSample.sector,
      peerSample.peers,
      now,
    );
    const { result: financialHealth, errors: healthErrors } = await computeFinancialHealth(
      result.ticker,
      peerSample.sector,
      peerSample.peers,
      now,
    );

    errors.push(...peerSample.errors, ...profileErrors, ...valuationErrors, ...healthErrors);
    perTicker.set(result.ticker, { growth: result, snapshot: { profile, valuation, financialHealth } });
  }

  const tickerComparison = classifyTickerComparison(
    results.map((r) => r.ticker),
    perTicker,
  );

  return { tickerComparison, portfolioScanErrors: errors };
}
