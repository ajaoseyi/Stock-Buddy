/**
 * =============================================================================
 * tools/alpha-vantage.ts — REST client for Alpha Vantage.
 * =============================================================================
 *
 * ROLE (CLAUDE.md §5.2, as amended by §5.8)
 * -----------------------------------------
 * Alpha Vantage does two jobs, and it is the scarcest resource in the project:
 *
 *   1. `ETF_PROFILE`       — the AUTHORITATIVE source of sector-ETF holding
 *                            weights, feeding the weight score (§5.4).
 *   2. `TIME_SERIES_DAILY` — the secondary cross-check on sector performance,
 *                            replacing the retired `SECTOR` endpoint (§5.8a).
 *
 * THE BUDGET IS THE DESIGN CONSTRAINT
 * -----------------------------------
 * Free tier: **25 requests per day, 5 per minute.** Not 25 per run — 25 per
 * DAY, shared across every developer, test run, and restart. That single number
 * shapes this file more than anything else:
 *
 *   - TTLs are long (7 days for holdings, 24h for prices) — §6.
 *   - The cross-check covers only the sectors the report will actually name,
 *     not all 11 (§5.8a).
 *   - `hasQuotaFor()` below lets a caller check the remaining budget BEFORE
 *     committing to a fan-out it cannot finish.
 *
 * ⚠️ THE SINGLE MOST IMPORTANT THING TO KNOW ABOUT THIS API
 * ---------------------------------------------------------
 * **Alpha Vantage signals every error with HTTP 200.** There is no 4xx, no 5xx,
 * no `ok === false`. A bad key, an unknown symbol, an exhausted quota, and a
 * retired endpoint all arrive as a perfectly successful HTTP response whose
 * BODY carries the bad news under one of several keys:
 *
 *     { "Information":   "..." }   rate limited / demo-key restriction
 *     { "Note":          "..." }   throughput limit hit (legacy phrasing)
 *     { "Error Message": "..." }   invalid symbol or malformed request
 *     { }                          endpoint retired (this is how we detected
 *                                  that `SECTOR` is dead — §5.8a)
 *
 * A client that only checks `response.ok` will sail straight past all four and
 * hand a `{ Information: ... }` object to a zod schema expecting price data.
 * The failure then surfaces as a confusing validation error a layer away from
 * its cause. `parseAlphaVantageEnvelope()` below exists solely to catch this,
 * and it runs BEFORE any schema parsing.
 */

import { z } from "zod";
import { getApiCallCounts, withCache } from "./cache.js";

const SOURCE = "alpha_vantage";
const BASE_URL = "https://www.alphavantage.co/query";

/**
 * Documented free-tier ceiling. Used by `hasQuotaFor()` for a best-effort
 * in-process guard.
 *
 * NOTE ON ITS LIMITS: this counter resets when the process restarts, and Alpha
 * Vantage counts per API key across every machine using it. So this is an
 * early-warning tripwire that prevents a single runaway fan-out, NOT an
 * accurate ledger of the day's remaining quota. The real defence against
 * exhaustion is the cache (§6); this is the seatbelt.
 */
export const ALPHA_VANTAGE_DAILY_LIMIT = 25;

// =============================================================================
// SECTION 1 — Error envelope detection
// =============================================================================

/** The four shapes Alpha Vantage uses to report a failure inside a 200 response. */
const ErrorEnvelopeSchema = z.object({
  Information: z.string().optional(),
  Note: z.string().optional(),
  "Error Message": z.string().optional(),
});

/**
 * Raised when Alpha Vantage reports a problem in a 200-OK body.
 *
 * A distinct class (rather than a bare `Error`) so callers can tell "the
 * provider refused" apart from "the network failed" — §5.7 requires quota
 * exhaustion specifically to degrade into a Yahoo-only cross-check with a note,
 * rather than failing the capability.
 */
export class AlphaVantageApiError extends Error {
  /** True when the message indicates a rate/quota limit rather than a bad request. */
  readonly isRateLimit: boolean;

  constructor(message: string, isRateLimit: boolean) {
    super(message);
    this.name = "AlphaVantageApiError";
    this.isRateLimit = isRateLimit;
  }
}

/**
 * Inspect a decoded Alpha Vantage body and throw if it carries an error.
 *
 * MUST be called before any data schema is applied — see the header note on
 * HTTP-200 errors. Returns the body unchanged when it looks like real data, so
 * it composes as a pass-through inside a `fetcher`.
 *
 * @throws {AlphaVantageApiError} if the body is an error envelope or is empty.
 */
export function parseAlphaVantageEnvelope(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    throw new AlphaVantageApiError(`Expected a JSON object, received ${typeof body}.`, false);
  }

  const envelope = ErrorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    const message =
      envelope.data.Information ?? envelope.data.Note ?? envelope.data["Error Message"];
    if (message !== undefined) {
      // Rate-limit wording varies across Alpha Vantage's responses, so match on
      // the recurring vocabulary rather than one exact string.
      const isRateLimit = /rate limit|frequency|premium|demo|per day|thank you/i.test(message);
      throw new AlphaVantageApiError(message, isRateLimit);
    }
  }

  // An empty object is how a RETIRED endpoint responds — this is precisely the
  // signature that identified `SECTOR` as dead (§5.8a). Treated as an error
  // because silently returning "no data" would let a caller conclude the
  // sectors genuinely had no movement.
  if (Object.keys(body as Record<string, unknown>).length === 0) {
    throw new AlphaVantageApiError(
      "Empty response body — the endpoint is likely retired or unavailable.",
      false,
    );
  }

  return body;
}

// =============================================================================
// SECTION 2 — Schemas
// =============================================================================

/**
 * Alpha Vantage returns EVERY number as a string: `"0.0828"`, `"223.6500"`.
 *
 * `z.coerce.number()` converts at the parse boundary so nothing downstream ever
 * does arithmetic on a string. This is not pedantry — in JavaScript
 * `"0.08" + 0.02` is `"0.080.02"`, so a missed conversion produces a silently
 * wrong weight rather than a crash.
 *
 * The refinement rejects `NaN`, which is what coercion yields for a
 * non-numeric string like Alpha Vantage's `"n/a"` (seen in `portfolio_turnover`).
 */
const NumericString = z.coerce.number().refine((n) => Number.isFinite(n), {
  message: "Expected a numeric string, got a non-numeric value (e.g. 'n/a')",
});

/**
 * One constituent of an ETF, from `ETF_PROFILE`.
 *
 * `weight` is a FRACTION: `"0.0828"` means 8.28% of the fund. Yahoo uses the
 * same convention (§5.8b). Conversion to percent happens once, in
 * `etf-holdings.ts`, so the two sources cannot drift onto different scales — a
 * 100× error in `weightScore` would silently wreck every quadrant assignment.
 */
export const AlphaVantageHoldingSchema = z.object({
  symbol: z.string(),
  description: z.string().optional(),
  weight: NumericString,
});

export const EtfProfileResponseSchema = z.object({
  net_assets: NumericString.optional(),
  net_expense_ratio: NumericString.optional(),
  /** ETF-level GICS sector breakdown. Not used today; captured for completeness. */
  sectors: z.array(z.object({ sector: z.string(), weight: NumericString })).optional(),
  /** The full constituent list — 105 rows for QQQ in a live check (§5.8b). */
  holdings: z.array(AlphaVantageHoldingSchema),
});

/**
 * One daily bar from `TIME_SERIES_DAILY`.
 *
 * The numbered key prefixes (`"1. open"`, `"4. close"`) are Alpha Vantage's
 * own convention — they exist to preserve field order in JSON, which is not
 * otherwise guaranteed. They are renamed to sane names by the transform in
 * `fetchDailySeries` so no downstream code has to know about them.
 */
export const AlphaVantageDailyBarSchema = z.object({
  "1. open": NumericString,
  "2. high": NumericString,
  "3. low": NumericString,
  "4. close": NumericString,
  "5. volume": NumericString,
});

export const DailySeriesResponseSchema = z.object({
  "Meta Data": z.object({
    "2. Symbol": z.string(),
    "3. Last Refreshed": z.string(),
  }),
  // Keyed by date string, e.g. "2026-07-31".
  "Time Series (Daily)": z.record(z.string(), AlphaVantageDailyBarSchema),
});

/** A daily bar in this project's own vocabulary, after renaming. */
export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type AlphaVantageHolding = z.infer<typeof AlphaVantageHoldingSchema>;
export type EtfProfileResponse = z.infer<typeof EtfProfileResponseSchema>;

// =============================================================================
// SECTION 3 — Quota guard
// =============================================================================

/**
 * Best-effort check that we have not already burned the daily budget.
 *
 * Call this before a fan-out (e.g. cross-checking six sectors) so the run can
 * degrade to Yahoo-only UP FRONT with a single clear note, rather than
 * half-completing and producing a report where some sectors are cross-checked
 * and others silently are not.
 *
 * @param needed how many calls the caller is about to make.
 * @returns `true` if the budget plausibly allows it.
 */
export function hasQuotaFor(needed: number): boolean {
  const used = getApiCallCounts()[SOURCE] ?? 0;
  return used + needed <= ALPHA_VANTAGE_DAILY_LIMIT;
}

/** Reads the API key at CALL time, so `dotenv.config()` has certainly run. */
function requireApiKey(): string {
  const key = process.env["ALPHA_VANTAGE_API_KEY"];
  if (key === undefined || key.trim() === "") {
    throw new Error(
      "ALPHA_VANTAGE_API_KEY is not set. Copy apps/server/.env.example to " +
        "apps/server/.env and add a key from https://www.alphavantage.co/support/#api-key",
    );
  }
  return key;
}

/**
 * Perform the HTTP request and decode it, applying the envelope check.
 *
 * Deliberately NOT exported: every caller must go through one of the cached
 * wrappers below, so §6's "no node calls an external API directly" holds.
 */
async function requestAlphaVantage(params: Record<string, string>): Promise<unknown> {
  const url = new URL(BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("apikey", requireApiKey());

  const response = await fetch(url);

  // Alpha Vantage rarely uses status codes for its own errors, but a genuine
  // network-layer failure (proxy, DNS, outage) still shows up here.
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  // The `unknown` return type is the point: nothing may treat this as data
  // until the envelope check and a zod schema have both run.
  return parseAlphaVantageEnvelope(await response.json());
}

// =============================================================================
// SECTION 4 — Public, cached fetchers
// =============================================================================

/**
 * Full constituent list and weights for an ETF — the authoritative weight
 * source for §5.4.
 *
 * Cached under `etf_holdings` → **7 day TTL** (§6: "holdings don't change
 * often"). At one call per analysed sector, a week of caching amortises to
 * well under one call per day.
 *
 * @param etfTicker e.g. `"XLK"`.
 * @throws {AlphaVantageApiError} on quota exhaustion — callers degrade per §5.7.
 */
export async function fetchEtfProfile(etfTicker: string): Promise<EtfProfileResponse> {
  return withCache({
    source: SOURCE,
    endpoint: "ETF_PROFILE",
    params: { symbol: etfTicker },
    namespace: "etf_holdings",
    schema: EtfProfileResponseSchema,
    fetcher: () => requestAlphaVantage({ function: "ETF_PROFILE", symbol: etfTicker }),
  });
}

/**
 * Daily price history for a symbol — the sector-trend cross-check (§5.8a).
 *
 * Cached under `sector_performance` → 24h TTL, matching what §5.2 originally
 * budgeted for the retired `SECTOR` endpoint.
 *
 * Returns bars sorted OLDEST FIRST. Alpha Vantage delivers newest-first, which
 * is the opposite of Yahoo's ordering; normalising here means `sector-trend.ts`
 * can apply identical `first`/`last` logic to both sources. Getting this
 * backwards would flip the sign of every cross-checked % change — a bug that
 * looks like a genuine source disagreement rather than an ordering mistake.
 *
 * @param outputSize `"compact"` = last 100 bars (enough for any window up to
 *                   ~5 months); `"full"` = 20+ years. Compact is the default
 *                   because payload size costs parse time on every cache read.
 */
export async function fetchDailySeries(
  symbol: string,
  outputSize: "compact" | "full" = "compact",
): Promise<DailyBar[]> {
  const response = await withCache({
    source: SOURCE,
    endpoint: "TIME_SERIES_DAILY",
    params: { symbol, outputsize: outputSize },
    namespace: "sector_performance",
    schema: DailySeriesResponseSchema,
    fetcher: () =>
      requestAlphaVantage({
        function: "TIME_SERIES_DAILY",
        symbol,
        outputsize: outputSize,
      }),
  });

  return (
    Object.entries(response["Time Series (Daily)"])
      .map(([date, bar]) => ({
        date,
        open: bar["1. open"],
        high: bar["2. high"],
        low: bar["3. low"],
        close: bar["4. close"],
        volume: bar["5. volume"],
      }))
      // ISO date strings sort lexicographically, which for YYYY-MM-DD is also
      // chronological — no Date parsing needed.
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  );
}
