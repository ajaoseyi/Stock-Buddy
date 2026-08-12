/**
 * =============================================================================
 * tests/tools/cache.test.ts
 * =============================================================================
 *
 * The cache is the load-bearing piece of CLAUDE.md §1's free-tier budget: if it
 * silently stops working, nothing breaks visibly — we just quietly burn 25
 * Alpha Vantage calls in an afternoon and start getting rate-limited. That
 * failure mode is exactly why this file tests behaviour (was the network
 * actually avoided?) rather than implementation details.
 *
 * The central technique used throughout: `withCache` takes its network call as
 * a `fetcher` callback, so a test can pass a counting stub instead. Asserting
 * `fetcher.mock.calls.length === 1` after two `withCache` calls is a DIRECT
 * assertion that the second one hit cache and made no request. No network is
 * involved, satisfying §8's "no live network calls in the test suite".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CacheStore,
  TTL_BY_NAMESPACE,
  getApiCallCounts,
  invalidateNamespace,
  resetApiCallCounts,
  setCacheForTesting,
  withCache,
} from "../../src/tools/cache.js";

// A minimal stand-in for a provider response.
const QuoteSchema = z.object({ symbol: z.string(), price: z.number() });
type Quote = z.infer<typeof QuoteSchema>;

let store: CacheStore;

beforeEach(() => {
  // A fresh in-memory database per test. ":memory:" never touches disk and is
  // destroyed with the connection, so tests cannot contaminate each other or
  // leave a stray .sqlite file behind.
  store = new CacheStore(":memory:");
  setCacheForTesting(store);
  resetApiCallCounts();
  // The cache reads CACHE_BYPASS from the environment; make sure a stray value
  // in the developer's shell cannot change what these tests measure.
  delete process.env["CACHE_BYPASS"];
  // Silence the intentional console output so test results stay readable.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  store.close();
  setCacheForTesting(null);
  vi.restoreAllMocks();
});

/** Build a `withCache` call with sensible defaults, overridable per test. */
function callWithCache(fetcher: () => Promise<unknown>, overrides = {}) {
  return withCache<Quote>({
    source: "test_provider",
    endpoint: "quote",
    params: { symbol: "XLK" },
    namespace: "daily_ohlcv",
    schema: QuoteSchema,
    fetcher,
    ...overrides,
  });
}

// =============================================================================
describe("withCache — the fetch-through contract", () => {
  // ---------------------------------------------------------------------------
  it("calls the fetcher on a miss and returns validated data", async () => {
    const fetcher = vi.fn(async () => ({ symbol: "XLK", price: 201.5 }));

    const result = await callWithCache(fetcher);

    expect(result).toEqual({ symbol: "XLK", price: 201.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // THE CENTRAL TEST. This single assertion is the free-tier budget.
  it("serves the second identical call from cache without touching the fetcher", async () => {
    const fetcher = vi.fn(async () => ({ symbol: "XLK", price: 201.5 }));

    const first = await callWithCache(fetcher);
    const second = await callWithCache(fetcher);

    expect(second).toEqual(first);
    // One logical query → exactly ONE real API call, no matter how many times
    // a node asks for it.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Guards the `stableStringify` key-ordering fix. Without it these two calls
  // would hash differently and silently double our quota burn.
  it("treats params with different key order as the same cache entry", async () => {
    const fetcher = vi.fn(async () => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher, { params: { symbol: "XLK", range: "1mo" } });
    await callWithCache(fetcher, { params: { range: "1mo", symbol: "XLK" } });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  it("treats genuinely different params as different entries", async () => {
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher, { params: { symbol: "XLK" } });
    await callWithCache(fetcher, { params: { symbol: "XLE" } });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(2);
  });

  // ---------------------------------------------------------------------------
  it("separates entries by source and endpoint, not just params", async () => {
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher, { source: "yahoo_finance" });
    await callWithCache(fetcher, { source: "alpha_vantage" });
    await callWithCache(fetcher, { source: "alpha_vantage", endpoint: "profile" });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(store.size()).toBe(3);
  });
});

// =============================================================================
describe("withCache — TTL and expiry", () => {
  // ---------------------------------------------------------------------------
  // Rather than sleeping (which would make the suite slow and flaky), we move
  // the CLOCK with fake timers. `Date.now()` is what the cache reads, so
  // advancing it by 25 hours is indistinguishable from actually waiting.
  it("re-fetches once a 24h TTL has elapsed", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher); // daily_ohlcv → 24h TTL
    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours later
    await callWithCache(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  it("still serves from cache just before the TTL expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher);
    vi.advanceTimersByTime(23 * 60 * 60 * 1000); // 23 hours — still fresh
    await callWithCache(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // §6: company sector/industry tags are cached indefinitely.
  it("never expires an indefinite-TTL namespace", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher, { namespace: "company_profile" });
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000); // a full year
    await callWithCache(fetcher, { namespace: "company_profile" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Locks the §6 TTL table itself, so a casual edit to a duration has to be
  // deliberate enough to also update this test.
  it("matches the TTL table in CLAUDE.md §6", () => {
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    expect(TTL_BY_NAMESPACE).toEqual({
      sector_price_history: 24 * HOUR, // §6: sector price history — 24h
      sector_performance: 24 * HOUR, // §5.2: AV SECTOR — call once, cache 24h
      etf_holdings: 7 * DAY, // §6: ETF holdings — 7 days
      daily_ohlcv: 24 * HOUR, // §6: daily OHLCV — 24h
      company_profile: null, // §6: company tags — indefinite
      quarterly_fundamentals: 14 * DAY, // growth-authenticity: quarterly financials/balance-sheet
    });
  });
});

// =============================================================================
describe("withCache — validation at the boundary (§2, §8)", () => {
  // ---------------------------------------------------------------------------
  it("throws with context when a response fails its schema", async () => {
    // `price` arrives as a string — the classic REST-API surprise.
    const fetcher = vi.fn(async () => ({ symbol: "XLK", price: "201.5" }));

    await expect(callWithCache(fetcher)).rejects.toThrow(/failed validation/);
  });

  // ---------------------------------------------------------------------------
  it("names the offending field so the failure is debuggable", async () => {
    const fetcher = vi.fn(async () => ({ symbol: "XLK", price: "201.5" }));

    await expect(callWithCache(fetcher)).rejects.toThrow(/price/);
  });

  // ---------------------------------------------------------------------------
  it("does not cache a response that failed validation", async () => {
    const fetcher = vi.fn(async () => ({ symbol: "XLK", price: "bad" }));

    await expect(callWithCache(fetcher)).rejects.toThrow();
    expect(store.size()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // §8: "every caught error either degrades ... or is rethrown with ADDED
  // CONTEXT." A bare "fetch failed" with no provider name is not debuggable.
  it("wraps a fetcher rejection with the source and endpoint", async () => {
    const fetcher = vi.fn(async (): Promise<unknown> => {
      throw new Error("ECONNRESET");
    });

    await expect(callWithCache(fetcher)).rejects.toThrow(/test_provider\/quote request failed/);
  });

  // ---------------------------------------------------------------------------
  it("preserves the original error as `cause`", async () => {
    const original = new Error("ECONNRESET");
    const fetcher = vi.fn(async (): Promise<unknown> => {
      throw original;
    });

    await expect(callWithCache(fetcher)).rejects.toMatchObject({ cause: original });
  });

  // ---------------------------------------------------------------------------
  // The schema-evolution guard: a row cached under an older, looser schema
  // must be re-fetched rather than trusted.
  it("re-fetches when a cached entry no longer satisfies the current schema", async () => {
    const LooseSchema = z.object({ symbol: z.string() });
    const loose = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK" }));

    // Written under the old shape (no `price`).
    await withCache({
      source: "test_provider",
      endpoint: "quote",
      params: { symbol: "XLK" },
      namespace: "daily_ohlcv",
      schema: LooseSchema,
      fetcher: loose,
    });
    expect(store.size()).toBe(1);

    // Now read with the CURRENT schema, which requires `price`.
    const strict = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));
    const result = await callWithCache(strict);

    expect(strict).toHaveBeenCalledTimes(1); // stale shape → treated as a miss
    expect(result).toEqual({ symbol: "XLK", price: 201.5 });
  });
});

// =============================================================================
describe("withCache — rate-limit visibility (§6)", () => {
  // ---------------------------------------------------------------------------
  it("counts real API calls per source, and only real ones", async () => {
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher, { source: "alpha_vantage", params: { symbol: "XLK" } });
    await callWithCache(fetcher, { source: "alpha_vantage", params: { symbol: "XLE" } });
    await callWithCache(fetcher, { source: "alpha_vantage", params: { symbol: "XLK" } }); // cached
    await callWithCache(fetcher, { source: "yahoo_finance", params: { symbol: "XLK" } });

    // Two live Alpha Vantage calls against a 25/day cap — the third was served
    // from cache and correctly did NOT increment the counter.
    expect(getApiCallCounts()).toEqual({ alpha_vantage: 2, yahoo_finance: 1 });
  });

  // ---------------------------------------------------------------------------
  it("logs every cache miss and stays silent on a hit", async () => {
    const info = vi.mocked(console.info);
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/MISS → live call #1 to test_provider\/quote/);

    await callWithCache(fetcher); // hit — must not log
    expect(info).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
describe("withCache — CACHE_BYPASS escape hatch", () => {
  // ---------------------------------------------------------------------------
  it("skips the cache read when CACHE_BYPASS=true", async () => {
    process.env["CACHE_BYPASS"] = "true";
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher);
    await callWithCache(fetcher);

    // Both calls went to the network — which is the documented (expensive)
    // point of the flag.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  it("still WRITES to the cache while bypassing reads", async () => {
    process.env["CACHE_BYPASS"] = "true";
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    await callWithCache(fetcher);
    expect(store.size()).toBe(1);

    // Turning the flag off returns to normal cached behaviour immediately.
    delete process.env["CACHE_BYPASS"];
    await callWithCache(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
describe("CacheStore — invalidation (§6 'invalidate manually if needed')", () => {
  // ---------------------------------------------------------------------------
  it("clears all entries for a source", async () => {
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));
    await callWithCache(fetcher, { source: "finnhub", params: { symbol: "NVDA" } });
    await callWithCache(fetcher, { source: "finnhub", params: { symbol: "AMD" } });
    await callWithCache(fetcher, { source: "yahoo_finance", params: { symbol: "NVDA" } });

    const removed = invalidateNamespace("finnhub");

    expect(removed).toBe(2);
    expect(store.size()).toBe(1); // the yahoo_finance entry survives
  });

  // ---------------------------------------------------------------------------
  it("can narrow invalidation to a single endpoint", async () => {
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));
    await callWithCache(fetcher, { source: "finnhub", endpoint: "profile2" });
    await callWithCache(fetcher, { source: "finnhub", endpoint: "quote" });

    expect(invalidateNamespace("finnhub", "profile2")).toBe(1);
    expect(store.size()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // The only way to clear an indefinitely-cached Finnhub company profile.
  it("forces a re-fetch of an indefinite entry after invalidation", async () => {
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "NVDA", price: 1.0 }));
    await callWithCache(fetcher, { source: "finnhub", namespace: "company_profile" });
    await callWithCache(fetcher, { source: "finnhub", namespace: "company_profile" });
    expect(fetcher).toHaveBeenCalledTimes(1);

    invalidateNamespace("finnhub");
    await callWithCache(fetcher, { source: "finnhub", namespace: "company_profile" });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
describe("CacheStore — resilience (§8: a broken cache must not fail a run)", () => {
  // ---------------------------------------------------------------------------
  it("degrades to a live fetch when the cache read throws", async () => {
    // Simulate a corrupt/locked database by making reads blow up.
    vi.spyOn(store, "get").mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    });
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    // The point: this RESOLVES. A broken cache costs quota, not the run.
    await expect(callWithCache(fetcher)).resolves.toEqual({ symbol: "XLK", price: 201.5 });
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringMatching(/read failed/));
  });

  // ---------------------------------------------------------------------------
  it("still returns good data when the cache WRITE throws", async () => {
    vi.spyOn(store, "set").mockImplementation(() => {
      throw new Error("SQLITE_FULL: database or disk is full");
    });
    const fetcher = vi.fn(async (): Promise<unknown> => ({ symbol: "XLK", price: 201.5 }));

    // We already have a valid response in hand; failing to persist it is not a
    // reason to throw it away.
    await expect(callWithCache(fetcher)).resolves.toEqual({ symbol: "XLK", price: 201.5 });
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringMatching(/write failed/));
  });
});
