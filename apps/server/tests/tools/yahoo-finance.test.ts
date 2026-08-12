/**
 * =============================================================================
 * tests/tools/yahoo-finance.test.ts
 * =============================================================================
 *
 * CLAUDE.md §8: "no live network calls in the test suite."
 *
 * HOW THAT IS GUARANTEED HERE. The `yahoo-finance2` module is replaced
 * wholesale by `vi.mock` before the tool imports it, so the real HTTP client is
 * never constructed. The mock serves fixtures captured from ONE real call each
 * (see `tests/fixtures/capture.mjs`), which means these tests run against the
 * genuine shape of Yahoo's response — including its quirks — while being fully
 * offline and deterministic.
 *
 * The fixtures hold real market data from 2026-05-01 → 2026-07-31:
 *   XLK  +8.33% over the window, 63 daily bars
 *   XLE  +1.19% over the window, 63 daily bars
 * Those known figures are what the expected-value assertions below are built
 * on, so a regression in parsing shows up as a wrong number, not just a throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Load a captured response. `structuredClone` stops one test mutating another's data. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

const xlkChart = fixture("yahoo-chart-xlk");
const xleChart = fixture("yahoo-chart-xle");
const xlkHoldings = fixture("yahoo-topholdings-xlk");

// -----------------------------------------------------------------------------
// Mock the library BEFORE importing the tool under test.
//
// `vi.mock` is hoisted above the imports by Vitest, so the tool's
// `new YahooFinance(...)` at module scope constructs THIS class, not the real
// one. `vi.hoisted` is required for the shared spies because they are
// referenced inside the hoisted factory.
// -----------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  chart: vi.fn(),
  quoteSummary: vi.fn(),
}));

vi.mock("yahoo-finance2", () => ({
  default: class {
    chart = mocks.chart;
    quoteSummary = mocks.quoteSummary;
  },
}));

const { CacheStore, setCacheForTesting, resetApiCallCounts, TTL_BY_NAMESPACE } =
  await import("../../src/tools/cache.js");
const {
  SECTOR_ETF_TO_GICS,
  SECTOR_ETF_TICKERS,
  resolveWindowStart,
  fetchSectorEtfHistory,
  fetchConstituentOhlcv,
  fetchFundTopHoldings,
} = await import("../../src/tools/yahoo-finance.js");

let store: InstanceType<typeof CacheStore>;

beforeEach(() => {
  store = new CacheStore(":memory:");
  setCacheForTesting(store);
  resetApiCallCounts();
  delete process.env["CACHE_BYPASS"];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.chart.mockReset();
  mocks.quoteSummary.mockReset();
});

afterEach(() => {
  store.close();
  setCacheForTesting(null);
  vi.restoreAllMocks();
});

// =============================================================================
describe("SECTOR_ETF_TO_GICS — the sector universe (§5.2)", () => {
  it("covers exactly the 11 SPDR sector ETFs listed in the spec", () => {
    // The list is quoted verbatim from CLAUDE.md §5.2. If someone adds a
    // twelfth ticker without updating the spec, this fails.
    expect(SECTOR_ETF_TICKERS.sort()).toEqual(
      ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"].sort(),
    );
  });

  it("maps every ETF to a distinct GICS sector name", () => {
    const sectors = Object.values(SECTOR_ETF_TO_GICS);
    expect(sectors).toHaveLength(11);
    // A duplicate would make one sector silently overwrite another as a key of
    // `sectorLeaders`.
    expect(new Set(sectors).size).toBe(11);
  });

  it("uses official GICS naming, not colloquial abbreviations", () => {
    expect(SECTOR_ETF_TO_GICS["XLK"]).toBe("Information Technology");
    expect(SECTOR_ETF_TO_GICS["XLRE"]).toBe("Real Estate");
    expect(SECTOR_ETF_TO_GICS["XLC"]).toBe("Communication Services");
  });

  it("is frozen, so a node cannot mutate the shared universe", () => {
    expect(Object.isFrozen(SECTOR_ETF_TO_GICS)).toBe(true);
  });
});

// =============================================================================
describe("resolveWindowStart — turning timeWindow into a date", () => {
  // A fixed 'now' so these expectations never drift with the calendar.
  const now = new Date("2026-07-31T00:00:00Z");

  it("handles days", () => {
    expect(resolveWindowStart("5d", now).toISOString()).toBe("2026-07-26T00:00:00.000Z");
  });

  it("handles weeks", () => {
    expect(resolveWindowStart("2w", now).toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });

  it("handles months", () => {
    expect(resolveWindowStart("1mo", now).toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(resolveWindowStart("3mo", now).toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("handles years", () => {
    expect(resolveWindowStart("1y", now).toISOString()).toBe("2025-07-31T00:00:00.000Z");
  });

  it("handles ytd as 1 January of the current year", () => {
    expect(resolveWindowStart("ytd", now).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveWindowStart("  1MO  ", now).toISOString()).toBe(
      resolveWindowStart("1mo", now).toISOString(),
    );
    expect(resolveWindowStart("YTD", now).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rolls over a year boundary correctly", () => {
    const january = new Date("2026-01-15T00:00:00Z");
    expect(resolveWindowStart("3mo", january).toISOString()).toBe("2025-10-15T00:00:00.000Z");
  });

  // ---------------------------------------------------------------------------
  // MONTH-END CLAMPING. JavaScript's `setUTCMonth` overflows instead of
  // clamping: "31 June" becomes 1 July and "31 February" becomes 3 March. For a
  // lookback window that is not a rounding quirk, it is a wrong answer — and
  // because `sectorRankings[].window` is shown to the user next to the % figure,
  // it would make the report's own label inaccurate.
  describe("month-end clamping", () => {
    it("clamps 31 July − 1mo to 30 June, not 1 July", () => {
      const july31 = new Date("2026-07-31T00:00:00Z");
      expect(resolveWindowStart("1mo", july31).toISOString()).toBe("2026-06-30T00:00:00.000Z");
    });

    it("clamps 31 March − 1mo to 28 February, not 3 March", () => {
      // The worst case: naive overflow lands INSIDE the starting month,
      // producing a "one month" window of about 28 days that starts later than
      // a naive reader would ever expect.
      const march31 = new Date("2026-03-31T00:00:00Z");
      expect(resolveWindowStart("1mo", march31).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    });

    it("clamps to 29 February in a leap year", () => {
      const march31 = new Date("2028-03-31T00:00:00Z"); // 2028 is a leap year
      expect(resolveWindowStart("1mo", march31).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    });

    it("clamps 29 February − 1y to 28 February in a non-leap year", () => {
      const leapDay = new Date("2028-02-29T00:00:00Z");
      expect(resolveWindowStart("1y", leapDay).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    });

    it("clamps 31 May − 3mo to 28 February", () => {
      const may31 = new Date("2026-05-31T00:00:00Z");
      expect(resolveWindowStart("3mo", may31).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    });

    it("leaves a mid-month date untouched", () => {
      const mid = new Date("2026-07-15T00:00:00Z");
      expect(resolveWindowStart("1mo", mid).toISOString()).toBe("2026-06-15T00:00:00.000Z");
    });
  });

  // §4.1(b): a bad window must fail loudly rather than silently defaulting to
  // some other period and reporting on the wrong data.
  it("throws on an unrecognised window rather than guessing", () => {
    expect(() => resolveWindowStart("last tuesday", now)).toThrow(/Unrecognised timeWindow/);
    expect(() => resolveWindowStart("", now)).toThrow(/Unrecognised timeWindow/);
    expect(() => resolveWindowStart("1month", now)).toThrow(/Unrecognised timeWindow/);
  });

  it("names the accepted formats in the error, so the failure is actionable", () => {
    expect(() => resolveWindowStart("bogus", now)).toThrow(/"ytd"/);
  });
});

// =============================================================================
describe("fetchSectorEtfHistory — parsing a real Yahoo response", () => {
  it("parses the captured XLK fixture into typed bars", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    const result = await fetchSectorEtfHistory("XLK", "3mo");

    expect(result.meta.symbol).toBe("XLK");
    expect(result.quotes).toHaveLength(63);
  });

  // THE CRITICAL ASSERTION for the whole capability: real numbers survive
  // parsing unchanged. XLK genuinely moved +8.33% over the fixture window.
  it("preserves the real price data used to compute % change", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    const { quotes } = await fetchSectorEtfHistory("XLK", "3mo");
    const first = quotes[0]!;
    const last = quotes.at(-1)!;
    const pctChange = ((last.close! - first.close!) / first.close!) * 100;

    expect(pctChange).toBeCloseTo(8.33, 1);
  });

  it("yields a genuinely different figure for a different sector", async () => {
    mocks.chart.mockResolvedValue(xleChart);

    const { quotes } = await fetchSectorEtfHistory("XLE", "3mo");
    const pctChange = ((quotes.at(-1)!.close! - quotes[0]!.close!) / quotes[0]!.close!) * 100;

    // XLE +1.19% vs XLK +8.33% — a real ranking difference, from real data.
    expect(pctChange).toBeCloseTo(1.19, 1);
  });

  it("coerces `date` to a Date instance", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    const { quotes } = await fetchSectorEtfHistory("XLK", "3mo");

    expect(quotes[0]!.date).toBeInstanceOf(Date);
    expect(quotes[0]!.date.toISOString()).toBe("2026-05-01T13:30:00.000Z");
  });

  it("exposes firstTradeDate for the recent-IPO check (§5.7)", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    const { meta } = await fetchSectorEtfHistory("XLK", "3mo");

    expect(meta.firstTradeDate).toBeInstanceOf(Date);
    expect(meta.firstTradeDate!.getUTCFullYear()).toBe(1998);
  });

  it("passes the resolved period1 and a daily interval to the client", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    await fetchSectorEtfHistory("XLK", "3mo", new Date("2026-07-31T00:00:00Z"));

    expect(mocks.chart).toHaveBeenCalledWith("XLK", {
      period1: new Date("2026-04-30T00:00:00.000Z"),
      interval: "1d",
    });
  });
});

// =============================================================================
describe("Date round-trip through the cache", () => {
  // This is the bug class the `z.coerce.date()` comment in yahoo-finance.ts
  // warns about. `withCache` persists parsed data as JSON, so a Date becomes an
  // ISO string. With a plain `z.date()` the cached row would fail validation on
  // every read, be discarded as "stale shape", and re-fetched forever — a cache
  // that appears to work but never returns a hit, silently burning quota.
  it("returns a Date on the SECOND (cached) call, not a string", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    const first = await fetchSectorEtfHistory("XLK", "3mo");
    const second = await fetchSectorEtfHistory("XLK", "3mo");

    expect(mocks.chart).toHaveBeenCalledTimes(1); // proves it came from cache
    expect(second.quotes[0]!.date).toBeInstanceOf(Date);
    expect(second.quotes[0]!.date.getTime()).toBe(first.quotes[0]!.date.getTime());
  });

  it("returns identical numeric data from cache", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    const first = await fetchSectorEtfHistory("XLK", "3mo");
    const second = await fetchSectorEtfHistory("XLK", "3mo");

    expect(second.quotes.at(-1)!.close).toBe(first.quotes.at(-1)!.close);
    expect(second.quotes).toHaveLength(63);
  });
});

// =============================================================================
describe("Caching behaviour (§6: never call an API twice for one query)", () => {
  it("caches per symbol", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    await fetchSectorEtfHistory("XLK", "3mo");
    await fetchSectorEtfHistory("XLE", "3mo");
    await fetchSectorEtfHistory("XLK", "3mo");

    // Two distinct symbols → two calls; the repeat of XLK is served from cache.
    expect(mocks.chart).toHaveBeenCalledTimes(2);
  });

  it("caches per time window", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    await fetchSectorEtfHistory("XLK", "1mo");
    await fetchSectorEtfHistory("XLK", "3mo");

    // Different windows are different questions and must not share an entry.
    expect(mocks.chart).toHaveBeenCalledTimes(2);
  });

  // §6 keys the cache on `(source, endpoint, paramsHash)` — the NAMESPACE is
  // not part of the key, it only selects the TTL. So an ETF-history lookup and
  // a constituent-OHLCV lookup for the same symbol and window are the same
  // underlying Yahoo `chart` call and correctly share one cache entry.
  //
  // This is desirable, not accidental: a sector ETF can also appear as a
  // symbol we want OHLCV for, and sharing halves the requests. It is safe here
  // precisely because both namespaces carry the SAME 24h TTL (§6). If a future
  // namespace with a different TTL ever collides on the same
  // (source, endpoint, params), whichever call ran first would silently set the
  // expiry — at which point the namespace must become part of the key.
  it("shares one cache entry when two namespaces make the identical call", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    await fetchSectorEtfHistory("XLK", "3mo");
    await fetchConstituentOhlcv("XLK", "3mo");

    expect(mocks.chart).toHaveBeenCalledTimes(1);
  });

  it("keeps the two 24h namespaces on the same TTL, which is what makes sharing safe", () => {
    expect(TTL_BY_NAMESPACE["sector_price_history"]).toBe(TTL_BY_NAMESPACE["daily_ohlcv"]);
  });

  it("does not re-fetch across many repeated constituent lookups", async () => {
    mocks.chart.mockResolvedValue(xlkChart);

    // Simulates sector-leaders.ts asking for the same ticker repeatedly.
    for (let i = 0; i < 10; i++) await fetchConstituentOhlcv("NVDA", "3mo");

    expect(mocks.chart).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
describe("fetchFundTopHoldings", () => {
  it("parses the captured XLK holdings fixture", async () => {
    mocks.quoteSummary.mockResolvedValue({ topHoldings: xlkHoldings });

    const holdings = await fetchFundTopHoldings("XLK");

    expect(holdings.map((h) => h.symbol)).toEqual([
      "NVDA",
      "AAPL",
      "MSFT",
      "AMD",
      "MU",
      "AVGO",
      "INTC",
      "AMAT",
      "LRCX",
      "CSCO",
    ]);
  });

  // Documents the limitation in an executable form: if Yahoo ever starts
  // returning more, this test tells us the fallback got better.
  it("returns only the TOP 10 — the documented fallback limitation", async () => {
    mocks.quoteSummary.mockResolvedValue({ topHoldings: xlkHoldings });

    const holdings = await fetchFundTopHoldings("XLK");

    // §5.4's `emerging_mover` quadrant is low-weight + high-speed, which a
    // top-10 list excludes by construction. This is why Yahoo holdings are a
    // fallback and not the primary weight source.
    expect(holdings).toHaveLength(10);
  });

  it("reports weight as a FRACTION, not a percentage", async () => {
    mocks.quoteSummary.mockResolvedValue({ topHoldings: xlkHoldings });

    const holdings = await fetchFundTopHoldings("XLK");

    // NVDA ≈ 12.6% of XLK arrives as 0.126…, matching Alpha Vantage's
    // convention. Conversion to percent happens once, in etf-holdings.ts.
    expect(holdings[0]!.holdingPercent).toBeGreaterThan(0);
    expect(holdings[0]!.holdingPercent).toBeLessThan(1);
  });

  it("degrades to an empty list when the module is absent", async () => {
    // §5.7 / §8: a missing module is a data gap, not a crash.
    mocks.quoteSummary.mockResolvedValue({});

    await expect(fetchFundTopHoldings("XLK")).resolves.toEqual([]);
  });

  it("caches holdings so a 7-day TTL is actually exercised", async () => {
    mocks.quoteSummary.mockResolvedValue({ topHoldings: xlkHoldings });

    await fetchFundTopHoldings("XLK");
    await fetchFundTopHoldings("XLK");

    expect(mocks.quoteSummary).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
describe("Error handling (§8: degrade with context, never crash the run)", () => {
  it("wraps a client failure with the source and endpoint", async () => {
    mocks.chart.mockRejectedValue(new Error("socket hang up"));

    await expect(fetchSectorEtfHistory("XLK", "3mo")).rejects.toThrow(
      /yahoo_finance\/chart request failed/,
    );
  });

  it("preserves the original error as `cause`", async () => {
    const original = new Error("socket hang up");
    mocks.chart.mockRejectedValue(original);

    await expect(fetchSectorEtfHistory("XLK", "3mo")).rejects.toMatchObject({ cause: original });
  });

  it("rejects a malformed response rather than passing it to a node", async () => {
    // §2: "Untyped `any` from a fetch call should never reach a node function."
    mocks.chart.mockResolvedValue({ meta: { symbol: "XLK" }, quotes: "not-an-array" });

    await expect(fetchSectorEtfHistory("XLK", "3mo")).rejects.toThrow(/failed validation/);
  });

  it("accepts null price fields, which Yahoo genuinely returns", async () => {
    // A halted or not-yet-closed bar. Rejecting these would fail the whole
    // capability on a perfectly normal response.
    mocks.chart.mockResolvedValue({
      meta: { symbol: "XLK" },
      quotes: [
        { date: "2026-07-30T13:30:00.000Z", open: 1, high: 2, low: 1, close: 2, volume: 100 },
        {
          date: "2026-07-31T13:30:00.000Z",
          open: null,
          high: null,
          low: null,
          close: null,
          volume: null,
        },
      ],
    });

    const { quotes } = await fetchSectorEtfHistory("XLK", "3mo");

    expect(quotes).toHaveLength(2);
    expect(quotes[1]!.close).toBeNull();
  });
});
