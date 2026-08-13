/**
 * =============================================================================
 * company-profile.ts — general, unpeer-compared company facts. DETERMINISTIC.
 * =============================================================================
 *
 * PLAIN FUNCTION, NOT A LANGGRAPH NODE — see `company-snapshot-scan.ts` for
 * why this whole capability's compute layer is plain functions rather than a
 * node chain (§13.7).
 *
 * Extracts facts straight off `fetchCompanyFundamentalsSnapshot`'s combined
 * `quoteSummary` bundle (§13.2) — no peer comparison, no computation beyond
 * unit conversion. `valuation-metrics.ts`/`financial-health.ts` are where the
 * peer-relative work happens.
 */

import { fetchCompanyFundamentalsSnapshot } from "../../../tools/yahoo-finance.js";
import type { CompanyProfileFacts } from "../../../state.js";
import { mapYahooSectorToGics } from "./peer-sample.js";

/**
 * `summaryDetail.dividendYield` and `financialData.revenueGrowth` are
 * reported as FRACTIONS by Yahoo (consistent with the fractional convention
 * already documented for ETF holding weights, §5.8b) — converted to percent
 * here, the one place either figure is read. Not yet live-verified for this
 * specific pair of fields; §13.11 records that as an open calibration item.
 */
function toPercent(fraction: number | undefined): number | null {
  return fraction === undefined ? null : fraction * 100;
}

/**
 * Build the general-facts slice of a company snapshot for one ticker.
 *
 * Never throws for a data-availability problem (§8) — a fetch failure
 * degrades to `{ result: null }` with the reason in `errors`; a successful
 * fetch with sparse coverage (thin listing, ADR) degrades per-field to
 * `null` rather than omitting the field (§13.10).
 */
export async function computeCompanyProfile(
  ticker: string,
  now: Date = new Date(),
): Promise<{ result: CompanyProfileFacts | null; errors: string[] }> {
  void now; // kept for signature symmetry with valuation-metrics.ts/financial-health.ts; the snapshot fetch is not window-dependent.
  try {
    const snapshot = await fetchCompanyFundamentalsSnapshot(ticker);

    const result: CompanyProfileFacts = {
      sector: mapYahooSectorToGics(snapshot.assetProfile.sector),
      industry: snapshot.assetProfile.industry ?? null,
      marketCap: snapshot.summaryDetail.marketCap ?? null,
      fullTimeEmployees: snapshot.assetProfile.fullTimeEmployees ?? null,
      beta: snapshot.summaryDetail.beta ?? null,
      dividendYieldPct: toPercent(snapshot.summaryDetail.dividendYield),
      fiftyTwoWeekLow: snapshot.summaryDetail.fiftyTwoWeekLow ?? null,
      fiftyTwoWeekHigh: snapshot.summaryDetail.fiftyTwoWeekHigh ?? null,
      trailingEps: snapshot.defaultKeyStatistics.trailingEps ?? null,
      forwardEps: snapshot.defaultKeyStatistics.forwardEps ?? null,
      analystTargetMeanPrice: snapshot.financialData.targetMeanPrice ?? null,
      analystRecommendationKey: snapshot.financialData.recommendationKey ?? null,
      reportedRevenueGrowthPct: toPercent(snapshot.financialData.revenueGrowth),
    };

    return { result, errors: [] };
  } catch (error) {
    return {
      result: null,
      errors: [
        `${ticker}: company profile fetch failed — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
