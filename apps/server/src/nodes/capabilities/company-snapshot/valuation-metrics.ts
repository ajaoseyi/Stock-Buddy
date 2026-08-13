/**
 * =============================================================================
 * valuation-metrics.ts — valuation multiples vs. sector peers. DETERMINISTIC.
 * =============================================================================
 *
 * PLAIN FUNCTION, NOT A LANGGRAPH NODE — see `company-snapshot-scan.ts` (§13.7).
 *
 * Four metrics — trailing P/E, forward P/E, price/book, EV/EBITDA — each
 * robust-z-scored (median/MAD, `lib/stats.ts`) against a bounded sample of
 * the ticker's sector peers (`resolvePeerSample`). ALL FOUR use
 * `higherIsBetter: false`: a lower multiple means cheaper relative to peers,
 * labelled `"favorable_vs_peers"` — a discount/premium framing, never
 * "good/bad" outright (§13.5: cheap is not unconditionally good, and this
 * file must not imply it is; that framing instruction lives in the
 * report-writer prompt, not here).
 *
 * Never blends the four metrics into one "valuation score" — §9, unmodified
 * by §9.1's carve-out (that carve-out applies only to §12.8's cross-ticker
 * verdict, not to a single company's own metrics).
 */

import { fetchCompanyFundamentalsSnapshot, type CompanyFundamentalsSnapshot } from "../../../tools/yahoo-finance.js";
import { ROBUST_Z_THRESHOLD, median, robustZScore } from "../../../lib/stats.js";
import type { PeerRelativeMetric, ValuationMetricsResult } from "../../../state.js";

/**
 * Turn a robust z-score into a peer-relative flag.
 *
 * Exported so `financial-health.ts` reuses it rather than duplicating —
 * both files perform the identical "z-score → favorable/unfavorable/in-line"
 * reduction, just over different metric sets and `higherIsBetter` directions.
 */
export function flagFromZScore(
  zScore: number | null,
  higherIsBetter: boolean,
): PeerRelativeMetric["flag"] {
  if (zScore === null) return "not_computable";
  if (Math.abs(zScore) < ROBUST_Z_THRESHOLD) return "in_line_with_peers";
  const favorable = higherIsBetter ? zScore > 0 : zScore < 0;
  return favorable ? "favorable_vs_peers" : "unfavorable_vs_peers";
}

interface ValuationMetricDef {
  metric: string;
  extract: (s: CompanyFundamentalsSnapshot) => number | null;
}

/** EV/EBITDA is computed, not read directly — guarded against a missing/non-positive denominator. */
function evToEbitda(s: CompanyFundamentalsSnapshot): number | null {
  const ev = s.defaultKeyStatistics.enterpriseValue;
  const ebitda = s.financialData.ebitda;
  if (ev === undefined || ebitda === undefined || ebitda <= 0) return null;
  return ev / ebitda;
}

const VALUATION_METRIC_DEFS: ValuationMetricDef[] = [
  { metric: "trailing_pe", extract: (s) => s.summaryDetail.trailingPE ?? null },
  { metric: "forward_pe", extract: (s) => s.summaryDetail.forwardPE ?? null },
  { metric: "price_to_book", extract: (s) => s.defaultKeyStatistics.priceToBook ?? null },
  { metric: "ev_to_ebitda", extract: evToEbitda },
];

/**
 * Build the valuation slice of a company snapshot for one ticker, against up
 * to `peers.length` sector peers already resolved by `resolvePeerSample`.
 *
 * Fetches each peer's combined fundamentals snapshot (same 24h-cached
 * namespace `computeCompanyProfile` uses — a peer already fetched by a prior
 * request in this run is free). Peer fetch failures are isolated per-peer
 * (`Promise.allSettled`, mirroring `sector-benchmark.ts`'s own pattern) —
 * one bad peer degrades the sample size, never the whole computation.
 */
export async function computeValuationMetrics(
  ticker: string,
  sector: string | null,
  peers: string[],
  now: Date = new Date(),
): Promise<{ result: ValuationMetricsResult | null; errors: string[] }> {
  void now;
  const errors: string[] = [];

  let target: CompanyFundamentalsSnapshot;
  try {
    target = await fetchCompanyFundamentalsSnapshot(ticker);
  } catch (error) {
    return {
      result: null,
      errors: [
        `${ticker}: valuation metrics not computable — fundamentals fetch failed ` +
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
        `${ticker}: valuation peer sample degraded — ${peerSnapshots.length} of ${peers.length} ` +
          `peer fundamentals fetches succeeded.`,
      );
    }
  } else {
    errors.push(`${ticker}: no sector peers resolved — valuation metrics reported without peer comparison.`);
  }

  const metrics: PeerRelativeMetric[] = VALUATION_METRIC_DEFS.map(({ metric, extract }) => {
    const value = extract(target);
    const peerValues = peerSnapshots.map(extract).filter((v): v is number => v !== null);
    const peerMedian = peerValues.length > 0 ? median(peerValues) : null;
    // `robustZScore` defaults its own `minSamples` to `MIN_BASELINE_QUARTERS` —
    // below that many peer values, it returns null and `flagFromZScore` reports
    // `not_computable` (§13.10), rather than trusting a z-score from too few peers.
    const zScore = value === null ? null : robustZScore(peerValues, value);
    return {
      metric,
      value,
      peerMedian,
      zScore,
      higherIsBetter: false,
      flag: flagFromZScore(zScore, false),
    };
  });

  return { result: { sector, peerCount: peerSnapshots.length, metrics }, errors };
}
