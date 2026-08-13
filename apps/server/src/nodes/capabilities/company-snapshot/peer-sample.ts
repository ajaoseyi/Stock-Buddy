/**
 * =============================================================================
 * peer-sample.ts — resolve a ticker's sector + a bounded peer sample.
 * =============================================================================
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION
 * -------------------------------------
 * `valuation-metrics.ts`/`financial-health.ts` (§13.5/§13.6) both need the
 * same sector + peer list, so it is resolved once here rather than twice.
 * Also re-exported via `./index.ts` (alongside the three compute functions)
 * because `ticker-comparison.ts`, in the SEPARATE portfolio-scan capability
 * folder, needs the identical resolution (§12.8) — not part of the
 * report-writer/validator-facing surface, just a second internal consumer.
 *
 * WHY `YAHOO_SECTOR_TO_GICS` IS DUPLICATED HERE, NOT IMPORTED
 * -------------------------------------------------------------
 * `growth-authenticity/sector-benchmark.ts` already exports an identical
 * ~15-line map. Importing it would be the more obvious move, but the
 * codebase's own stated policy (formerly on `growth-authenticity/stats.ts`,
 * now on `lib/stats.ts`) is "duplicate until a THIRD consumer appears, then
 * promote" — this file is only the SECOND consumer, so duplicating here is
 * the policy-consistent choice, not an oversight. Also keeps this capability
 * folder self-contained per CLAUDE.md §3's containment rule.
 */

import { fetchEtfHoldings } from "../../../tools/etf-holdings.js";
import { SECTOR_ETF_TO_GICS, fetchCompanySector } from "../../../tools/yahoo-finance.js";

/** Yahoo's `assetProfile.sector` taxonomy, mapped to GICS names. Local copy — see header. */
const YAHOO_SECTOR_TO_GICS: Readonly<Record<string, string>> = Object.freeze({
  Technology: "Information Technology",
  Energy: "Energy",
  "Financial Services": "Financials",
  Healthcare: "Health Care",
  Industrials: "Industrials",
  "Consumer Cyclical": "Consumer Discretionary",
  "Consumer Defensive": "Consumer Staples",
  Utilities: "Utilities",
  "Basic Materials": "Materials",
  "Real Estate": "Real Estate",
  "Communication Services": "Communication Services",
});

/** Map a Yahoo sector taxonomy string to the GICS name, or `null` if unmapped. Local copy — see header. */
export function mapYahooSectorToGics(yahooSector: string | undefined): string | null {
  if (yahooSector === undefined) return null;
  return YAHOO_SECTOR_TO_GICS[yahooSector] ?? null;
}

/**
 * How many (heaviest) sector peers to sample. Own local constant — NOT
 * imported from `sector-benchmark.ts`'s identically-named-and-valued
 * constant, same containment reasoning as the map above.
 */
const PEER_SAMPLE_SIZE = 10;

export interface PeerSample {
  sector: string | null;
  /** Up to `PEER_SAMPLE_SIZE` heaviest peer tickers, excluding `ticker` itself. */
  peers: string[];
  errors: string[];
}

/**
 * Resolve `ticker`'s GICS sector and a bounded sample of its heaviest sector
 * peers, via the existing `fetchEtfHoldings` (Alpha-Vantage-primary,
 * Yahoo-fallback — §5.8b, unmodified).
 *
 * Never throws — a resolution failure returns `{ sector: null, peers: [] }`
 * with the reason recorded in `errors`, so callers degrade the same way
 * `sector-benchmark.ts` already does for a missing sector/peer sample.
 */
export async function resolvePeerSample(ticker: string, now: Date = new Date()): Promise<PeerSample> {
  void now; // kept in the signature for symmetry with the other compute functions; sector/peer lookups are not window-dependent.
  const errors: string[] = [];

  let sector: string | null;
  try {
    const profile = await fetchCompanySector(ticker);
    sector = mapYahooSectorToGics(profile.sector);
  } catch (error) {
    errors.push(
      `${ticker}: sector lookup failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return { sector: null, peers: [], errors };
  }

  if (sector === null) {
    return { sector: null, peers: [], errors };
  }

  const etfTicker = Object.entries(SECTOR_ETF_TO_GICS).find(([, gics]) => gics === sector)?.[0];
  if (etfTicker === undefined) {
    errors.push(`${ticker}: no sector ETF mapping found for "${sector}".`);
    return { sector, peers: [], errors };
  }

  try {
    const holdings = await fetchEtfHoldings(etfTicker, sector);
    errors.push(...holdings.warnings);
    const peers = holdings.holdings
      .filter((h) => h.ticker !== ticker)
      .slice(0, PEER_SAMPLE_SIZE)
      .map((h) => h.ticker);
    return { sector, peers, errors };
  } catch (error) {
    errors.push(
      `${ticker}: sector peer sample unavailable — ` +
        `${error instanceof Error ? error.message : String(error)}.`,
    );
    return { sector, peers: [], errors };
  }
}
