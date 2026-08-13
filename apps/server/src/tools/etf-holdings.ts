/**
 * =============================================================================
 * tools/etf-holdings.ts — sector ETF constituents and their weights.
 * =============================================================================
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * The single answer to "which companies are in this sector, and how much of it
 * is each one?" — the input to the WEIGHT half of §5.4's weight/speed pair.
 *
 * It is a composition layer, not a client: it calls `alpha-vantage.ts` and
 * `yahoo-finance.ts` rather than the network, so §6's "no node calls an
 * external API directly" still holds, and every underlying request is already
 * cached at a 7-day TTL.
 *
 * THE SOURCE HIERARCHY (§5.4, as resolved in §5.8b)
 * -------------------------------------------------
 * Three tiers, tried in order, each degradation explicitly recorded:
 *
 *   1. Alpha Vantage `ETF_PROFILE`  — PRIMARY. The full constituent list
 *      (105 rows for QQQ in a live check). §5.4 calls ETF-disclosed holdings
 *      "the authoritative structural-size metric".
 *
 *   2. Yahoo `topHoldings`          — FALLBACK. Only the TOP 10.
 *
 *   3. Market cap                   — LAST RESORT, §5.4: "do not derive it
 *      from raw market cap unless holdings data is unavailable, in which case
 *      fall back explicitly and flag the fallback in `trendDataErrors`."
 *
 * WHY THE TIER MATTERS MORE THAN IT LOOKS
 * ---------------------------------------
 * Tier 2 is not merely "less complete". §5.4's `emerging_mover` quadrant is
 * LOW weight + HIGH speed, and the top 10 holdings of a sector ETF are by
 * construction the HIGH-weight names. So a tier-2 result makes one of the four
 * quadrants unreachable — and it is precisely the one §5.5 asks the report
 * writer to surface as an "early signal" callout.
 *
 * A silent tier-2 fallback would therefore produce a report that is not merely
 * less detailed but quietly misleading: it would state there are no emerging
 * movers in a sector when the truth is that we never looked. That is why
 * `HoldingsResult` below carries its own provenance and warnings rather than
 * returning a bare array — the caller CANNOT accidentally ignore the
 * degradation, because the array is not the return value.
 *
 * THE UNIT CONTRACT
 * -----------------
 * Both upstream sources report weight as a FRACTION (`0.0828` = 8.28%). This
 * file is the ONE place that converts to percent, so the two can never drift
 * onto different scales. A 100× error in `weightScore` would silently wreck
 * every quadrant assignment while still producing numbers that look ordinary.
 */

import { asAlphaVantageError, fetchEtfProfile } from "./alpha-vantage.js";
import { fetchFundTopHoldings } from "./yahoo-finance.js";

// =============================================================================
// SECTION 1 — Types
// =============================================================================

/** Where a holdings list came from. Determines how far it can be trusted. */
export type HoldingsSource =
  /** Alpha Vantage ETF_PROFILE — full constituent list. All four quadrants reachable. */
  | "alpha_vantage_etf_profile"
  /** Yahoo topHoldings — top 10 only. `emerging_mover` unreachable. */
  | "yahoo_top_holdings";

/** One constituent, with its weight already normalised to a percentage. */
export interface EtfHolding {
  ticker: string;
  /** Company name where the source provides one. */
  name?: string;
  /**
   * Percentage weight in the ETF. 8.28 means 8.28% of the fund.
   *
   * NOTE THE SCALE: this is a PERCENT, converted here from the fraction both
   * upstream sources use. It feeds `SectorLeader.weightScore` directly, so the
   * conversion happening exactly once — here — is what keeps every quadrant
   * threshold meaningful.
   */
  weightPct: number;
}

/**
 * A holdings lookup, with its provenance attached.
 *
 * Returning this instead of a bare `EtfHolding[]` is a deliberate design
 * choice: it makes the degradation impossible to overlook. A caller that wants
 * the array has to go through `.holdings`, at which point `.source` and
 * `.warnings` are right there. §5.4 requires the fallback to be flagged in
 * `trendDataErrors`, and this shape is what makes forgetting it awkward.
 */
export interface HoldingsResult {
  /** Sorted by weight, heaviest first. */
  holdings: EtfHolding[];
  source: HoldingsSource;
  /**
   * Human-readable degradation notes, ready to be appended to
   * `trendDataErrors` verbatim. Empty when the primary source succeeded.
   */
  warnings: string[];
  /**
   * `true` when the list is known to be incomplete (tier 2), meaning
   * `emerging_mover` classification is unreliable for this sector.
   */
  isPartial: boolean;
}

// =============================================================================
// SECTION 2 — The lookup
// =============================================================================

/** Fraction (0.0828) → percent (8.28). The single conversion point. */
function toPercent(fraction: number): number {
  return fraction * 100;
}

/**
 * Fetch the constituents and weights for one sector ETF.
 *
 * Tries Alpha Vantage first, falls back to Yahoo, and reports which happened.
 * NEVER THROWS for a data-availability problem — §8 forbids letting a
 * tool-layer failure crash a graph run, and §5.7 requires degrading with a
 * note. A total failure returns an empty list with warnings, so the sector is
 * simply reported without leaders rather than taking down the whole request.
 *
 * @param etfTicker e.g. `"XLK"`.
 * @param sectorName the GICS name, used only to make warnings readable.
 */
export async function fetchEtfHoldings(
  etfTicker: string,
  sectorName: string = etfTicker,
): Promise<HoldingsResult> {
  const warnings: string[] = [];

  // --- Tier 1: Alpha Vantage ETF_PROFILE (authoritative) --------------------
  try {
    const profile = await fetchEtfProfile(etfTicker);

    if (profile.holdings.length > 0) {
      return {
        holdings: normalise(
          profile.holdings.map((h) => ({
            ticker: h.symbol,
            ...(h.description === undefined ? {} : { name: h.description }),
            weightPct: toPercent(h.weight),
          })),
        ),
        source: "alpha_vantage_etf_profile",
        warnings,
        isPartial: false,
      };
    }

    // A 200 response with an empty holdings array — real, but useless.
    warnings.push(
      `${sectorName} (${etfTicker}): Alpha Vantage returned no holdings; falling back to Yahoo top-10.`,
    );
  } catch (error) {
    // Distinguish quota exhaustion from a genuine failure, because §5.7 treats
    // them differently in the narrative even though both fall back the same way.
    // `asAlphaVantageError` unwraps `withCache`'s error wrapping (§6) — a plain
    // `instanceof AlphaVantageApiError` check is always false past the cache
    // layer, which silently broke this distinction (see sector-trend.ts's
    // identical fix for the live symptom this caused).
    const avError = asAlphaVantageError(error);
    const reason =
      avError !== null && avError.isRateLimit
        ? "Alpha Vantage daily quota exhausted"
        : `Alpha Vantage unavailable (${avError !== null ? avError.message : error instanceof Error ? error.message : String(error)})`;

    warnings.push(`${sectorName} (${etfTicker}): ${reason}; falling back to Yahoo top-10.`);
  }

  // --- Tier 2: Yahoo topHoldings (top 10 only) ------------------------------
  try {
    const topHoldings = await fetchFundTopHoldings(etfTicker);

    if (topHoldings.length > 0) {
      // THE CONSEQUENTIAL WARNING. Without this line the report would state
      // there are no emerging movers in this sector, when the truth is that
      // the data could not show one (§5.8b).
      warnings.push(
        `${sectorName} (${etfTicker}): weights derived from the top ${topHoldings.length} ` +
          `holdings only — low-weight constituents are absent, so "emerging_mover" ` +
          `classification is incomplete for this sector.`,
      );

      return {
        holdings: normalise(
          topHoldings.map((h) => ({
            ticker: h.symbol,
            ...(h.holdingName === undefined ? {} : { name: h.holdingName }),
            weightPct: toPercent(h.holdingPercent),
          })),
        ),
        source: "yahoo_top_holdings",
        warnings,
        isPartial: true,
      };
    }

    warnings.push(`${sectorName} (${etfTicker}): Yahoo returned no holdings either.`);
  } catch (error) {
    warnings.push(
      `${sectorName} (${etfTicker}): Yahoo holdings fallback also failed ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  // --- Total failure: degrade, do not throw (§8) -----------------------------
  // The sector still appears in `sectorRankings` with its % change; it simply
  // has no leader breakdown. A partial answer with a stated caveat beats no
  // answer at all.
  return {
    holdings: [],
    source: "yahoo_top_holdings",
    warnings,
    isPartial: true,
  };
}

/**
 * Placeholder symbols that mean "this row is not a tradeable equity".
 *
 * ⚠️ THESE ARE OBSERVED VALUES, NOT GUESSES. Every real SPDR sector ETF holds
 * three or four non-equity positions, and Alpha Vantage reports all of them
 * with the symbol `"n/a"` (lowercase). Live examples from `ETF_PROFILE`:
 *
 *   XLF  n/a  "XAF FINANCIAL SEP26 XCME 20260918"            → index futures
 *   XLF  n/a  "SSI US GOV MONEY MARKET CLASS STATE STREET"   → cash sweep fund
 *   XLF  n/a  "US DOLLAR" / "POUND STERLING"                 → currency balances
 *
 * Left unfiltered, each becomes a request to Yahoo for a ticker named "N/A",
 * which 404s. That produces a wasted API call, a spurious `trendDataErrors`
 * entry, and — worst — a phantom row in the leader table carrying a real
 * weight, which the report writer could then name as a company.
 */
const NON_EQUITY_SYMBOLS = new Set(["", "-", "--", "N/A", "NA", "CASH", "USD"]);

/**
 * A plausible equity ticker: 1-6 characters, starting with a letter, allowing
 * the dot and dash that appear in real symbols (`BRK.B`, `BF.B`).
 *
 * Applied AFTER uppercasing, as a catch-all for placeholder forms not in the
 * list above — a provider inventing a new one should drop the row rather than
 * leak it downstream.
 */
const TICKER_PATTERN = /^[A-Z][A-Z.-]{0,5}$/;

/**
 * Clean a holdings list: drop non-equity rows and sort heaviest first.
 *
 * Order matters here. The ticker is uppercased FIRST and then tested — an
 * earlier version filtered before normalising case, so the lowercase `"n/a"`
 * that Alpha Vantage actually returns slipped past a check for `"CASH"`.
 */
function normalise(holdings: EtfHolding[]): EtfHolding[] {
  return holdings
    .map((h) => ({ ...h, ticker: h.ticker.trim().toUpperCase() }))
    .filter((h) => {
      if (NON_EQUITY_SYMBOLS.has(h.ticker)) return false;
      if (!TICKER_PATTERN.test(h.ticker)) return false;
      // A non-finite or non-positive weight cannot participate in a tercile
      // split and would poison the threshold calculation.
      return Number.isFinite(h.weightPct) && h.weightPct > 0;
    })
    .sort((a, b) => b.weightPct - a.weightPct);
}
