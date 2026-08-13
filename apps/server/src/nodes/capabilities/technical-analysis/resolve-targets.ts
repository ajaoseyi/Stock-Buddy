/**
 * =============================================================================
 * resolve-targets.ts — decide what symbols this run actually analyses.
 * DETERMINISTIC, no LLM.
 * =============================================================================
 *
 * Turns `state.tickers`/`state.sectors` (already parsed by `supervisor.ts` —
 * this file re-parses nothing, per state.ts's "nothing downstream re-parses
 * the user's text" rule) into a capped list of concrete symbols to run
 * technical analysis on.
 *
 * TICKERS TAKE PRIORITY OVER SECTORS. A request naming both ("NVDA and the
 * tech sector") analyses the ticker; sector-only requests (confirmed product
 * decision, CLAUDE.md §14.3) run directly on that sector's ETF, e.g.
 * Technology -> XLK, reusing `SECTOR_ETF_TO_GICS` from the tools layer.
 */

import { SECTOR_ETF_TO_GICS } from "../../../tools/yahoo-finance.js";
import { TECHNICAL_ANALYSIS_TICKER_CAP } from "./constants.js";

export interface ResolvedTarget {
  /** Ticker or sector ETF ticker, e.g. "NVDA" or "XLK". */
  symbol: string;
  requestedAs: "ticker" | "sector_etf";
  /** Populated only when `requestedAs === "sector_etf"` — the GICS name the user actually named. */
  sectorName: string | null;
}

const GICS_TO_ETF = new Map(Object.entries(SECTOR_ETF_TO_GICS).map(([etf, sector]) => [sector, etf]));

/**
 * @returns up to `TECHNICAL_ANALYSIS_TICKER_CAP` targets, plus which named
 *          tickers/sectors were skipped for exceeding the cap, plus any
 *          resolution errors (a named sector with no ETF mapping — defensive;
 *          `SECTOR_ETF_TO_GICS` covers all 11 GICS sectors, so this should
 *          not occur in practice, but degrading honestly costs nothing).
 */
export function resolveTechnicalAnalysisTargets(
  tickers: string[],
  sectors: string[],
): { targets: ResolvedTarget[]; skipped: string[]; errors: string[] } {
  const errors: string[] = [];

  const candidates: ResolvedTarget[] =
    tickers.length > 0
      ? tickers.map((symbol) => ({ symbol, requestedAs: "ticker" as const, sectorName: null }))
      : sectors.flatMap((sectorName) => {
          const etf = GICS_TO_ETF.get(sectorName);
          if (etf === undefined) {
            errors.push(`${sectorName}: no sector ETF mapping found — cannot run technical analysis.`);
            return [];
          }
          return [{ symbol: etf, requestedAs: "sector_etf" as const, sectorName }];
        });

  const targets = candidates.slice(0, TECHNICAL_ANALYSIS_TICKER_CAP);
  const skipped = candidates.slice(TECHNICAL_ANALYSIS_TICKER_CAP).map((c) => c.symbol);

  return { targets, skipped, errors };
}
