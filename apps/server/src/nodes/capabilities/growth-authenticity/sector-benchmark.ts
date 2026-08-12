/**
 * =============================================================================
 * sector-benchmark.ts — is this just the sector's/commodity's beta? DETERMINISTIC.
 * =============================================================================
 *
 * Fourth node in the growth-authenticity pipeline (see ./index.ts). No LLM,
 * ever (§1, §9).
 *
 * THE CASE THIS FILE EXISTS TO CATCH
 * -----------------------------------
 * An energy stock rising because oil went $70→$90/barrel is not company-
 * specific news, even though `price-revenue-discrepancy.ts` alone cannot tell
 * the difference — a sector-wide commodity move can produce the exact same
 * price/revenue signature. This node resolves the company's own sector and
 * asks whether ITS price move is unusual even against ITS SECTOR PEERS' price
 * moves, not just against the sector ETF's average.
 *
 * SECTOR-RELATIVE, NOT A FLAT PERCENTAGE-POINT CUTOFF
 * -------------------------------------------------------
 * Mirrors CLAUDE.md §5.9(a)'s precedent for `sector-leaders.ts`'s quadrant
 * thresholds: what counts as "a big move" varies by how volatile the sector
 * normally is, so a flat spread cutoff would misfire across sectors the same
 * way a flat PP&E cutoff misfires across asset-heavy vs. asset-light
 * companies (`inorganic-signal.ts`). The target's own spread-vs-ETF is
 * z-scored (robust median/MAD, ./stats.ts) against a bounded sample of its
 * sector peers' own spread-vs-ETF, computed over the same window.
 *
 * BOUNDED PEER SAMPLE, DELIBERATELY
 * ------------------------------------
 * This is a single-ticker capability (`single_report` intent) — fetching all
 * ~100 constituents of a sector ETF (as `sector-leaders.ts` does for a
 * sector-wide report) would be a disproportionate cost for answering one
 * ticker's question. `PEER_SAMPLE_SIZE` takes the heaviest constituents
 * instead, which is a reasonable proxy for "how does this sector normally
 * move" without the full fan-out.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, SectorBenchmarkResult } from "../../../state.js";
import { emitProgress } from "../../../streaming.js";
import { fetchEtfHoldings } from "../../../tools/etf-holdings.js";
import {
  SECTOR_ETF_TO_GICS,
  fetchCompanySector,
  fetchConstituentOhlcv,
  fetchSectorEtfHistory,
} from "../../../tools/yahoo-finance.js";
import { computePctChangeFromBars } from "./price-revenue-discrepancy.js";
import { ROBUST_Z_THRESHOLD, robustZScore } from "./stats.js";

/**
 * Yahoo's `assetProfile.sector` taxonomy, mapped to the GICS names used by
 * `SECTOR_ETF_TO_GICS`. Local to this file, not `yahoo-finance.ts` — that file
 * stays a thin fetcher, mirroring how `SECTOR_ALIASES` already lives in
 * `supervisor.ts` rather than the tool layer.
 */
export const YAHOO_SECTOR_TO_GICS: Readonly<Record<string, string>> = Object.freeze({
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

/** How many (heaviest) sector peers to sample for the spread distribution. */
const PEER_SAMPLE_SIZE = 10;

const notComputable = (): SectorBenchmarkResult => ({
  sector: null,
  sectorBenchmarkPct: null,
  stockVsSectorSpreadPct: null,
  macroBetaFlag: "not_computable",
});

/** Map a Yahoo sector taxonomy string to the GICS name, or `null` if unmapped. */
export function mapYahooSectorToGics(yahooSector: string | undefined): string | null {
  if (yahooSector === undefined) return null;
  return YAHOO_SECTOR_TO_GICS[yahooSector] ?? null;
}

/**
 * READS  `tickers`, `timeWindow`, `priceRevenueDiscrepancy`
 * WRITES `sectorBenchmark`, `growthCheckErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * MUST run after `priceRevenueDiscrepancyNode`, which populates
 * `state.priceRevenueDiscrepancy.priceChangePct`.
 */
export async function sectorBenchmarkNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const growthCheckErrors = [...state.growthCheckErrors];
  const ticker = state.tickers[0];
  const priceChangePct = state.priceRevenueDiscrepancy?.priceChangePct ?? null;

  if (ticker === undefined || priceChangePct === null) {
    return { sectorBenchmark: notComputable(), growthCheckErrors };
  }

  emitProgress(
    config,
    "sector_benchmark",
    `Checking whether ${ticker}'s move is just its sector's beta...`,
  );

  // --- Resolve the company's GICS sector --------------------------------------
  let sector: string | null;
  try {
    const profile = await fetchCompanySector(ticker);
    sector = mapYahooSectorToGics(profile.sector);
    if (sector === null) {
      growthCheckErrors.push(
        `${ticker}: sector "${profile.sector ?? "unknown"}" could not be mapped to a GICS sector ` +
          `— sector-benchmark comparison not computable.`,
      );
      return { sectorBenchmark: notComputable(), growthCheckErrors };
    }
  } catch (error) {
    growthCheckErrors.push(
      `${ticker}: sector lookup failed — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { sectorBenchmark: notComputable(), growthCheckErrors };
  }

  const etfTicker = Object.entries(SECTOR_ETF_TO_GICS).find(([, gics]) => gics === sector)?.[0];
  if (etfTicker === undefined) {
    growthCheckErrors.push(`${ticker}: no sector ETF mapping found for "${sector}".`);
    return { sectorBenchmark: notComputable(), growthCheckErrors };
  }

  // --- Sector ETF's own price change over the same window ---------------------
  let sectorBenchmarkPct: number | null;
  try {
    const etfBars = await fetchSectorEtfHistory(etfTicker, state.timeWindow, now);
    sectorBenchmarkPct = computePctChangeFromBars(etfBars.quotes);
  } catch (error) {
    growthCheckErrors.push(
      `${ticker}: sector ETF (${etfTicker}) price history unavailable — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { sectorBenchmark: notComputable(), growthCheckErrors };
  }

  if (sectorBenchmarkPct === null) {
    growthCheckErrors.push(`${ticker}: insufficient sector ETF (${etfTicker}) price data.`);
    return { sectorBenchmark: notComputable(), growthCheckErrors };
  }

  const stockVsSectorSpreadPct = priceChangePct - sectorBenchmarkPct;

  // --- Peer sample: is the target's own spread unusual vs its sector peers? --
  let peerSpreads: number[] = [];
  try {
    const holdings = await fetchEtfHoldings(etfTicker, sector);
    const peers = holdings.holdings.filter((h) => h.ticker !== ticker).slice(0, PEER_SAMPLE_SIZE);

    const settled = await Promise.allSettled(
      peers.map(async (peer) => {
        const bars = await fetchConstituentOhlcv(peer.ticker, state.timeWindow, now);
        const pct = computePctChangeFromBars(bars.quotes);
        if (pct === null) return null;
        return pct - sectorBenchmarkPct!;
      }),
    );

    peerSpreads = settled
      .filter((r): r is PromiseFulfilledResult<number | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is number => v !== null);
  } catch (error) {
    growthCheckErrors.push(
      `${ticker}: sector peer sample unavailable — ` +
        `${error instanceof Error ? error.message : String(error)}. Macro-beta flag defaults to ` +
        `"stock_specific_move" rather than assuming it is explained by the sector.`,
    );
  }

  const spreadZScore = robustZScore(peerSpreads, stockVsSectorSpreadPct);

  // A missing/too-small peer baseline defaults to "stock_specific_move", not
  // "beta_explained" — the more cautious direction, since claiming a move is
  // "just the sector" without evidence is the confident-wrong-answer failure
  // mode this whole capability exists to avoid (CLAUDE.md §5.9(b)).
  const macroBetaFlag: SectorBenchmarkResult["macroBetaFlag"] =
    spreadZScore !== null && Math.abs(spreadZScore) < ROBUST_Z_THRESHOLD
      ? "beta_explained"
      : "stock_specific_move";

  return {
    sectorBenchmark: { sector, sectorBenchmarkPct, stockVsSectorSpreadPct, macroBetaFlag },
    growthCheckErrors,
  };
}
