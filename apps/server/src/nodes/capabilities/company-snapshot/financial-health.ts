/**
 * =============================================================================
 * financial-health.ts — margins/debt/returns vs. sector peers. DETERMINISTIC.
 * =============================================================================
 *
 * PLAIN FUNCTION, NOT A LANGGRAPH NODE — see `company-snapshot-scan.ts` (§13.7).
 *
 * Same shape as `valuation-metrics.ts` (§13.5), for six metrics: debt/equity
 * (`higherIsBetter: false` — less leverage is favourable), current ratio,
 * return on equity, return on assets, profit margin (all `higherIsBetter:
 * true`), and free-cash-flow margin (computed, `higherIsBetter: true`).
 *
 * Never blends the six metrics into one "health score" — §9, unmodified by
 * §9.1's carve-out (that applies only to §12.8's cross-ticker verdict).
 */

import { fetchCompanyFundamentalsSnapshot, type CompanyFundamentalsSnapshot } from "../../../tools/yahoo-finance.js";
import { median, robustZScore } from "../../../lib/stats.js";
import type { PeerRelativeMetric, FinancialHealthResult } from "../../../state.js";
import { flagFromZScore } from "./valuation-metrics.js";

interface HealthMetricDef {
  metric: string;
  higherIsBetter: boolean;
  extract: (s: CompanyFundamentalsSnapshot) => number | null;
}

/** FCF margin is computed, not read directly — guarded against a missing/non-positive denominator. */
function fcfMargin(s: CompanyFundamentalsSnapshot): number | null {
  const fcf = s.financialData.freeCashflow;
  const revenue = s.financialData.totalRevenue;
  if (fcf === undefined || revenue === undefined || revenue <= 0) return null;
  return fcf / revenue;
}

const HEALTH_METRIC_DEFS: HealthMetricDef[] = [
  { metric: "debt_to_equity", higherIsBetter: false, extract: (s) => s.financialData.debtToEquity ?? null },
  { metric: "current_ratio", higherIsBetter: true, extract: (s) => s.financialData.currentRatio ?? null },
  { metric: "return_on_equity", higherIsBetter: true, extract: (s) => s.financialData.returnOnEquity ?? null },
  { metric: "return_on_assets", higherIsBetter: true, extract: (s) => s.financialData.returnOnAssets ?? null },
  { metric: "profit_margin", higherIsBetter: true, extract: (s) => s.financialData.profitMargins ?? null },
  { metric: "fcf_margin", higherIsBetter: true, extract: fcfMargin },
];

/**
 * Build the financial-health slice of a company snapshot for one ticker,
 * against up to `peers.length` sector peers already resolved by
 * `resolvePeerSample`. Same fetch/degrade shape as `computeValuationMetrics` —
 * a separate call rather than sharing the target/peer fetch with it, so
 * either function can be used independently (§13.1's "shared data layer" is
 * the underlying `fetchCompanyFundamentalsSnapshot` cache, not a shared
 * in-memory object between these two functions).
 */
export async function computeFinancialHealth(
  ticker: string,
  sector: string | null,
  peers: string[],
  now: Date = new Date(),
): Promise<{ result: FinancialHealthResult | null; errors: string[] }> {
  void now;
  const errors: string[] = [];

  let target: CompanyFundamentalsSnapshot;
  try {
    target = await fetchCompanyFundamentalsSnapshot(ticker);
  } catch (error) {
    return {
      result: null,
      errors: [
        `${ticker}: financial-health metrics not computable — fundamentals fetch failed ` +
          `(${error instanceof Error ? error.message : String(error)}).`,
      ],
    };
  }

  const peerSnapshots: CompanyFundamentalsSnapshot[] = [];
  if (peers.length > 0) {
    const settled = await Promise.allSettled(peers.map((p) => fetchCompanyFundamentalsSnapshot(p)));
    for (const r of settled) {
      if (r.status === "fulfilled") peerSnapshots.push(r.value);
    }
    if (peerSnapshots.length < peers.length) {
      errors.push(
        `${ticker}: financial-health peer sample degraded — ${peerSnapshots.length} of ${peers.length} ` +
          `peer fundamentals fetches succeeded.`,
      );
    }
  } else {
    errors.push(
      `${ticker}: no sector peers resolved — financial-health metrics reported without peer comparison.`,
    );
  }

  const metrics: PeerRelativeMetric[] = HEALTH_METRIC_DEFS.map(({ metric, higherIsBetter, extract }) => {
    const value = extract(target);
    const peerValues = peerSnapshots.map(extract).filter((v): v is number => v !== null);
    const peerMedian = peerValues.length > 0 ? median(peerValues) : null;
    const zScore = value === null ? null : robustZScore(peerValues, value);
    return {
      metric,
      value,
      peerMedian,
      zScore,
      higherIsBetter,
      flag: flagFromZScore(zScore, higherIsBetter),
    };
  });

  return { result: { sector, peerCount: peerSnapshots.length, metrics }, errors };
}
