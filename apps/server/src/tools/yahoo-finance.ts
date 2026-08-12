/**
 * =============================================================================
 * tools/yahoo-finance.ts — price history and fund holdings via `yahoo-finance2`.
 * =============================================================================
 *
 * ROLE IN THE CAPABILITY (CLAUDE.md §5.2)
 * ---------------------------------------
 * Yahoo is the PRIMARY data source and does two of the four jobs:
 *
 *   1. Sector trend signal — % price change of each of the 11 SPDR sector ETFs
 *      over the requested window. Consumed by `sector-trend.ts` (§5.3).
 *   2. Sector leader SPEED — daily OHLCV for each sector constituent, from
 *      which `sector-leaders.ts` computes momentum and relative volume (§5.4).
 *
 * It also provides a no-key FALLBACK for fund holdings (see the important
 * caveat on `fetchFundTopHoldings` below).
 *
 * WHY YAHOO IS PRIMARY
 * --------------------
 * It needs no API key and has no documented request cap, which makes it the
 * only source we can afford to call per-constituent. §5.2 still says to "cache
 * aggressively" because it is an UNOFFICIAL upstream — there is no contract
 * behind it, so being a considerate client is both good manners and
 * self-preservation. Everything here goes through `withCache` at a 24h TTL,
 * which matches the data's real refresh rate: these are DAILY bars, so a
 * second call the same afternoon cannot return anything new.
 *
 * WHAT THIS FILE MUST NEVER DO (§6, §9)
 * -------------------------------------
 * Never call the network outside `withCache`. Every exported function here
 * routes through it. If you add a function, it does too.
 *
 * A NOTE ON THE v4 API
 * --------------------
 * `yahoo-finance2` v4 is a breaking rewrite of v3. v3 exported a ready-made
 * singleton (`import yf from "yahoo-finance2"; yf.chart(...)`). v4 exports a
 * CLASS that must be instantiated:
 *
 *     import YahooFinance from "yahoo-finance2";
 *     const yf = new YahooFinance();
 *
 * Calling a method on the un-instantiated export throws
 * "Call `const yahooFinance = new YahooFinance()` first." Verified against the
 * installed v4.0.0 — not a detail to take on faith from a tutorial written
 * against v3.
 */

import YahooFinance from "yahoo-finance2";
import { z } from "zod";
import { withCache } from "./cache.js";

// =============================================================================
// SECTION 1 — The client instance
// =============================================================================

/**
 * One shared client for the process.
 *
 * `suppressNotices: ["yahooSurvey"]` silences a console banner the library
 * prints asking users to fill in a survey. It is noise in server logs and,
 * more importantly, would drown out the cache-miss lines §6 requires us to be
 * able to read.
 */
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/** Provider identity, used as the `source` half of every cache key. */
const SOURCE = "yahoo_finance";

// =============================================================================
// SECTION 2 — The sector universe
// =============================================================================

/**
 * The 11 SPDR sector ETFs, mapped to their GICS sector names.
 *
 * This map IS the sector universe for this capability, and the ticker list is
 * taken verbatim from §5.2. Two reasons it is a hardcoded constant rather than
 * something fetched:
 *
 *   1. It is genuinely static. GICS has had 11 sectors since Real Estate was
 *      split out in 2016 and Communication Services was reworked in 2018.
 *   2. Fetching it would cost an API call to learn something that cannot
 *      change between runs — a poor use of a 25-call/day budget.
 *
 * The VALUES are the sector names that flow into `sectorRankings[].sector` and
 * become the keys of `sectorLeaders`, so they are what the user ultimately
 * reads in the report. They use official GICS naming ("Information
 * Technology", not "Tech") so the report's vocabulary matches what a finance
 * professional expects.
 */
export const SECTOR_ETF_TO_GICS: Readonly<Record<string, string>> = Object.freeze({
  XLK: "Information Technology",
  XLE: "Energy",
  XLF: "Financials",
  XLV: "Health Care",
  XLI: "Industrials",
  XLY: "Consumer Discretionary",
  XLP: "Consumer Staples",
  XLU: "Utilities",
  XLB: "Materials",
  XLRE: "Real Estate",
  XLC: "Communication Services",
});

/** The 11 sector ETF tickers, e.g. for iterating the whole universe. */
export const SECTOR_ETF_TICKERS = Object.keys(SECTOR_ETF_TO_GICS);

// =============================================================================
// SECTION 3 — Response schemas
// =============================================================================

/**
 * One daily OHLCV bar.
 *
 * TWO DETAILS HERE ARE LOAD-BEARING AND EASY TO GET WRONG:
 *
 * 1. `z.coerce.date()` rather than `z.date()`.
 *    The live library returns a real `Date` object. But `withCache` persists
 *    the PARSED value as JSON, and `JSON.stringify(new Date())` produces an
 *    ISO *string*. On the next cache hit the schema therefore sees a string,
 *    not a Date. A plain `z.date()` would reject it, `withCache` would log
 *    "stale shape" and re-fetch — every single time. The cache would appear to
 *    work while silently never returning a hit. `z.coerce.date()` accepts both
 *    forms and yields a `Date` either way; the round-trip is covered by a test.
 *
 * 2. Every price field is `.nullable()`.
 *    Yahoo returns `null` for a bar it has no data for — a trading halt, a
 *    stale listing, or the placeholder bar for today before the close. Modelling
 *    these as non-null would throw a validation error on a response that is
 *    perfectly normal, and §5.7 requires degrading gracefully rather than
 *    failing the capability. Downstream code filters nulls out explicitly.
 */
export const PriceBarSchema = z.object({
  date: z.coerce.date(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number().nullable(),
  /** Split/dividend-adjusted close. Preferred over `close` for % change math. */
  adjclose: z.number().nullable().optional(),
  volume: z.number().nullable(),
});

/** The subset of a `chart()` response this capability actually reads. */
export const ChartResponseSchema = z.object({
  meta: z.object({
    symbol: z.string(),
    currency: z.string().optional(),
    /**
     * Epoch seconds of the instrument's first ever trade. This is the field
     * that detects §5.7's recent-IPO edge case — if a company started trading
     * after the window opened, it cannot have a meaningful % change over that
     * window and must be excluded from the SPEED ranking (while still counting
     * for weight).
     */
    firstTradeDate: z.coerce.date().nullable().optional(),
    regularMarketPrice: z.number().nullable().optional(),
  }),
  quotes: z.array(PriceBarSchema),
});

/**
 * A single fund holding as Yahoo reports it.
 *
 * `holdingPercent` is a FRACTION, not a percentage: NVDA at 12.6% of XLK comes
 * back as `0.1264092`. Alpha Vantage's `ETF_PROFILE` uses the same fractional
 * convention. Converting to percent happens in exactly one place
 * (`etf-holdings.ts`) so the two sources cannot end up on different scales —
 * a 100× error in `weightScore` would silently wreck every quadrant.
 */
export const FundHoldingSchema = z.object({
  symbol: z.string(),
  holdingName: z.string().optional(),
  holdingPercent: z.number(),
});

export const TopHoldingsResponseSchema = z.object({
  holdings: z.array(FundHoldingSchema),
});

export type PriceBar = z.infer<typeof PriceBarSchema>;
export type ChartResponse = z.infer<typeof ChartResponseSchema>;
export type FundHolding = z.infer<typeof FundHoldingSchema>;

/**
 * One quarter's income-statement row, narrowed to the one field the
 * growth-authenticity capability needs. `yahoo-finance2`'s real response
 * carries dozens of optional fields (see `FundamentalsTimeSeriesFinancialsResult`
 * in the installed package's type defs); zod's default (non-`.strict()`)
 * `z.object()` picks this one out and drops the rest, same pattern
 * `ChartResponseSchema` already uses.
 */
export const QuarterlyFinancialsRowSchema = z.object({
  date: z.coerce.date(),
  totalRevenue: z.number().optional(),
});

/**
 * One quarter's balance-sheet row, narrowed to the fields the
 * growth-authenticity capability needs to detect M&A activity: goodwill only
 * moves materially through acquisition purchase accounting, PP&E and cash are
 * the corroborating pattern.
 */
export const QuarterlyBalanceSheetRowSchema = z.object({
  date: z.coerce.date(),
  goodwill: z.number().optional(),
  netPPE: z.number().optional(),
  cashAndCashEquivalents: z.number().optional(),
});

/** Yahoo's own sector/industry taxonomy for a company (`quoteSummary.assetProfile`). */
export const AssetProfileResponseSchema = z.object({
  sector: z.string().optional(),
  industry: z.string().optional(),
});

export type QuarterlyFinancialsRow = z.infer<typeof QuarterlyFinancialsRowSchema>;
export type QuarterlyBalanceSheetRow = z.infer<typeof QuarterlyBalanceSheetRowSchema>;
export type AssetProfileResponse = z.infer<typeof AssetProfileResponseSchema>;

// =============================================================================
// SECTION 4 — Time window resolution
// =============================================================================

/**
 * Translate an `AgentState.timeWindow` string into a concrete start date.
 *
 * `timeWindow` is deliberately a free-form string in the state schema (it is
 * passed through from the user's request), so this function is the single
 * place that string acquires meaning. Keeping the mapping here — rather than
 * letting each node interpret it — is what guarantees the sector trend and the
 * leader speed scores are measured over the SAME period. If they diverged, the
 * report would confidently narrate a mismatch.
 *
 * @param timeWindow e.g. `"5d"`, `"1mo"`, `"3mo"`, `"6mo"`, `"ytd"`, `"1y"`.
 * @param now        Injectable clock — tests pass a fixed date so expectations
 *                   do not drift with the calendar.
 * @returns the inclusive start of the window.
 * @throws if the window is unrecognised. Deliberately loud: §4.1(b) explains
 *         why a silently-defaulted window is worse than a failed request.
 */
export function resolveWindowStart(timeWindow: string, now: Date = new Date()): Date {
  const normalized = timeWindow.trim().toLowerCase();

  if (normalized === "ytd") {
    // Year to date — 1 January of the current year, in UTC to avoid a
    // machine's local timezone shifting the boundary by a day.
    return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }

  // Matches "<number><unit>", e.g. "5d", "1mo", "18mo", "2y".
  const match = /^(\d+)(d|w|mo|y)$/.exec(normalized);
  if (match === null) {
    throw new Error(
      `Unrecognised timeWindow "${timeWindow}". Expected one of: ` +
        `"<n>d", "<n>w", "<n>mo", "<n>y", or "ytd" (e.g. "5d", "1mo", "3mo", "1y").`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const start = new Date(now.getTime());

  switch (unit) {
    case "d":
      start.setUTCDate(start.getUTCDate() - amount);
      break;
    case "w":
      start.setUTCDate(start.getUTCDate() - amount * 7);
      break;
    case "mo":
      return subtractMonths(now, amount);
    case "y":
      // Whole years are subtracted through the same month-aware path so that
      // 29 February in a leap year clamps to 28 February rather than rolling
      // over into 1 March.
      return subtractMonths(now, amount * 12);
    default:
      // Unreachable — the regex above admits only the four units. Present so
      // `noImplicitReturns` and exhaustiveness checking are both satisfied.
      throw new Error(`Unhandled time unit "${unit ?? "undefined"}".`);
  }

  return start;
}

/**
 * Subtract whole months, CLAMPING the day to the last valid day of the target
 * month rather than letting it overflow.
 *
 * WHY THIS IS NOT `setUTCMonth(m - n)`. JavaScript's date setters do not clamp
 * — they normalise by rolling forward:
 *
 *     new Date("2026-07-31").setUTCMonth(5)   // "31 June" → 1 July 2026
 *     new Date("2026-03-31").setUTCMonth(1)   // "31 Feb"  → 3 March 2026
 *
 * Both results are wrong for a lookback window, and the second is badly wrong:
 * asking for "one month of history" from 31 March would return a window
 * starting three days LATER in the same month — roughly 28 days of data
 * mislabelled as a month, or on some dates an empty window.
 *
 * The financial convention, and what this implements, is end-of-month
 * clamping: 31 March − 1mo = 28 February, 31 July − 1mo = 30 June. Because
 * `sectorRankings[].window` is reported to the user alongside the % figure,
 * a window that does not mean what it says would make the report's own label
 * inaccurate.
 */
function subtractMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  // Total months since year 0, minus the offset — handles year rollover and
  // negative months without special cases.
  const totalMonths = year * 12 + month - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = totalMonths - targetYear * 12;

  // Day 0 of the NEXT month is the last day of the target month — the standard
  // trick for "how many days does this month have", and leap-year correct.
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(day, daysInTargetMonth),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

// =============================================================================
// SECTION 5 — Fetchers
// =============================================================================

/**
 * Internal: fetch a daily price series for one symbol, through the cache.
 *
 * Not exported — callers use one of the two named wrappers below, so that the
 * cache NAMESPACE (and therefore the TTL) is chosen by the use case rather
 * than passed in ad hoc at each call site.
 */
async function fetchChart(
  symbol: string,
  timeWindow: string,
  namespace: "sector_price_history" | "daily_ohlcv",
  now: Date,
): Promise<ChartResponse> {
  const period1 = resolveWindowStart(timeWindow, now);

  return withCache({
    source: SOURCE,
    endpoint: "chart",
    // `period1` is included as a DATE STRING, not a Date object or a raw
    // timestamp. Two reasons: a Date would hash by its millisecond value, so
    // two runs a second apart would miss each other's cache entries; and a
    // day-resolution key is the correct granularity for daily bars.
    params: {
      symbol,
      period1: period1.toISOString().slice(0, 10),
      interval: "1d",
      window: timeWindow,
    },
    namespace,
    schema: ChartResponseSchema,
    fetcher: () => yf.chart(symbol, { period1, interval: "1d" }),
  });
}

/**
 * Daily bars for one of the 11 SPDR sector ETFs. Feeds `sector-trend.ts`.
 *
 * Cached under `sector_price_history` → 24h TTL (§6).
 */
export async function fetchSectorEtfHistory(
  etfTicker: string,
  timeWindow: string,
  now: Date = new Date(),
): Promise<ChartResponse> {
  return fetchChart(etfTicker, timeWindow, "sector_price_history", now);
}

/**
 * Daily bars for one sector CONSTITUENT. Feeds the speed score in
 * `sector-leaders.ts`.
 *
 * Cached under `daily_ohlcv` → 24h TTL (§6). Separated from the ETF namespace
 * so the two can be invalidated independently while sharing the same duration.
 */
export async function fetchConstituentOhlcv(
  ticker: string,
  timeWindow: string,
  now: Date = new Date(),
): Promise<ChartResponse> {
  return fetchChart(ticker, timeWindow, "daily_ohlcv", now);
}

/**
 * Fund holdings for an ETF, with NO API key required.
 *
 * ⚠️ IMPORTANT LIMITATION — verified against the live API, not assumed:
 * Yahoo's `topHoldings` module returns only the **top 10** holdings. Alpha
 * Vantage's `ETF_PROFILE` returns the FULL constituent list (105 rows for QQQ
 * in a live check).
 *
 * This matters more than it first appears. §5.4's `emerging_mover` quadrant is
 * defined as LOW weight + HIGH speed — precisely the companies a top-10 list
 * excludes by construction. Building leaders from Yahoo holdings alone would
 * make one of the four quadrants permanently unreachable, and `emerging_mover`
 * is the one §5.5 asks the report writer to surface as an "early signal".
 *
 * So this is a FALLBACK, not the primary source. `etf-holdings.ts` owns that
 * decision and is responsible for recording the degradation in
 * `trendDataErrors` when it has to come here (§5.4).
 *
 * Cached under `etf_holdings` → 7 day TTL (§6).
 */
export async function fetchFundTopHoldings(etfTicker: string): Promise<FundHolding[]> {
  const result = await withCache({
    source: SOURCE,
    endpoint: "quoteSummary.topHoldings",
    params: { symbol: etfTicker },
    namespace: "etf_holdings",
    schema: TopHoldingsResponseSchema,
    fetcher: async () => {
      const response = await yf.quoteSummary(etfTicker, { modules: ["topHoldings"] });
      // Narrow to just the slice we validate. The full quoteSummary payload is
      // large and mostly irrelevant; caching all of it would bloat the DB for
      // no benefit.
      return response.topHoldings ?? { holdings: [] };
    },
  });

  return result.holdings;
}

// =============================================================================
// SECTION 6 — Quarterly fundamentals (growth-authenticity capability)
// =============================================================================

/**
 * Internal: fetch a quarterly fundamentals time series, through the cache.
 *
 * ⚠️ CACHE-KEY GRANULARITY. `now` is rounded DOWN to the first of its current
 * month before deriving `period1`/`period2`. Quarterly fundamentals change at
 * most once per ~90 days; a day-resolution key (like `fetchChart`'s, which is
 * correct THERE because daily bars genuinely change daily) would mint a fresh
 * cache entry — and a fresh live call — every single day `now` advances,
 * silently defeating the 14-day TTL. Same class of bug as §5.8's window
 * misalignment, just surfacing in the cache key instead of a comparison.
 *
 * `period1` reaches back 4 YEARS, not the ~1-2 years a single YoY comparison
 * would need, because the growth-authenticity nodes compute a robust
 * (median/MAD) baseline against the company's own trailing history — that
 * needs multiple years of quarters BEFORE the comparison window even starts.
 */
async function fetchFundamentalsTimeSeries<T>(
  symbol: string,
  moduleName: "financials" | "balance-sheet",
  rowSchema: z.ZodType<T>,
  now: Date,
): Promise<T[]> {
  const monthAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const period1 = new Date(
    Date.UTC(monthAnchor.getUTCFullYear() - 4, monthAnchor.getUTCMonth(), 1),
  );

  return withCache({
    source: SOURCE,
    endpoint: `fundamentalsTimeSeries.${moduleName}`,
    params: {
      symbol,
      module: moduleName,
      period1: period1.toISOString().slice(0, 10),
      period2: monthAnchor.toISOString().slice(0, 10),
    },
    namespace: "quarterly_fundamentals",
    schema: z.array(rowSchema),
    fetcher: () =>
      yf.fundamentalsTimeSeries(symbol, {
        type: "quarterly",
        module: moduleName,
        period1,
        period2: monthAnchor,
      }),
  });
}

/**
 * Quarterly revenue history for one ticker, ~4 years back. Feeds
 * `revenue-growth.ts` and `price-revenue-discrepancy.ts`'s historical baseline.
 *
 * A ticker with no fundamentals coverage (thin/ADR/non-US listing) returns an
 * EMPTY array rather than throwing — that is valid data (zero quarters), not a
 * fetch failure, and each calling node treats it as its own `insufficient_data`
 * case rather than a crash.
 */
export async function fetchQuarterlyFinancials(
  ticker: string,
  now: Date = new Date(),
): Promise<QuarterlyFinancialsRow[]> {
  return fetchFundamentalsTimeSeries(ticker, "financials", QuarterlyFinancialsRowSchema, now);
}

/**
 * Quarterly balance-sheet history for one ticker, ~4 years back. Feeds
 * `inorganic-signal.ts`.
 */
export async function fetchQuarterlyBalanceSheet(
  ticker: string,
  now: Date = new Date(),
): Promise<QuarterlyBalanceSheetRow[]> {
  return fetchFundamentalsTimeSeries(ticker, "balance-sheet", QuarterlyBalanceSheetRowSchema, now);
}

/**
 * Yahoo's own sector/industry taxonomy for one ticker. Feeds
 * `sector-benchmark.ts`'s macro-beta check.
 *
 * Reuses the existing `"company_profile"` namespace (indefinite TTL) rather
 * than inventing a new one — a cache namespace is a TTL bucket, not a
 * source-scoped concept (the cache key already carries `source`), and "company
 * sector tag, effectively never changes" is exactly the rationale already
 * documented for Finnhub's `stock/profile2` sector tag.
 */
export async function fetchCompanySector(ticker: string): Promise<AssetProfileResponse> {
  return withCache({
    source: SOURCE,
    endpoint: "quoteSummary.assetProfile",
    params: { symbol: ticker },
    namespace: "company_profile",
    schema: AssetProfileResponseSchema,
    fetcher: async () => {
      const response = await yf.quoteSummary(ticker, { modules: ["assetProfile"] });
      return response.assetProfile ?? {};
    },
  });
}
