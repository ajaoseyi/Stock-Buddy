/**
 * =============================================================================
 * tests/tools/alpha-vantage.test.ts
 * =============================================================================
 *
 * Fixtures are REAL captured responses (§8: no live calls in the suite):
 *
 *   alpha-vantage-etf-profile-qqq.json  105 holdings, weights 0.0828 → 0.0011
 *   alpha-vantage-daily-ibm.json        100 daily bars, IBM −10.61%
 *   alpha-vantage-ratelimit-note.json   a genuine HTTP-200 error envelope
 *
 * That third fixture matters as much as the other two. Alpha Vantage reports
 * every failure — bad key, exhausted quota, retired endpoint — inside a
 * successful HTTP 200 response. Testing against a real one is the only way to
 * be sure the detection actually matches what the provider sends, rather than
 * what we imagine it sends.
 *
 * `fetch` is stubbed globally, so no request leaves the machine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALPHA_VANTAGE_DAILY_LIMIT,
  AlphaVantageApiError,
  fetchDailySeries,
  fetchEtfProfile,
  hasQuotaFor,
  parseAlphaVantageEnvelope,
} from "../../src/tools/alpha-vantage.js";
import { CacheStore, resetApiCallCounts, setCacheForTesting } from "../../src/tools/cache.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

const etfProfileQqq = fixture("alpha-vantage-etf-profile-qqq");
const dailyIbm = fixture("alpha-vantage-daily-ibm");
const rateLimitNote = fixture("alpha-vantage-ratelimit-note");

let store: CacheStore;

/** Stub `fetch` to return a given JSON body with HTTP 200. */
function mockFetchJson(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  store = new CacheStore(":memory:");
  setCacheForTesting(store);
  resetApiCallCounts();
  delete process.env["CACHE_BYPASS"];
  process.env["ALPHA_VANTAGE_API_KEY"] = "test-key-not-real";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  store.close();
  setCacheForTesting(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// =============================================================================
describe("parseAlphaVantageEnvelope — HTTP 200 does not mean success", () => {
  it("throws on a REAL captured rate-limit envelope", () => {
    // The single most important behaviour in this file. Without it, this body
    // would flow into a zod schema expecting price data and fail confusingly
    // one layer away from its actual cause.
    expect(() => parseAlphaVantageEnvelope(rateLimitNote)).toThrow(AlphaVantageApiError);
  });

  it("classifies the captured envelope as a rate limit", () => {
    // §5.7 requires quota exhaustion to degrade into a Yahoo-only cross-check
    // with a note — which is only possible if it is distinguishable from a
    // malformed-request error.
    try {
      parseAlphaVantageEnvelope(rateLimitNote);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AlphaVantageApiError);
      expect((error as AlphaVantageApiError).isRateLimit).toBe(true);
    }
  });

  it("throws on a `Note` throughput envelope", () => {
    expect(() =>
      parseAlphaVantageEnvelope({
        Note: "Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute.",
      }),
    ).toThrow(/frequency/);
  });

  it("throws on an `Error Message` envelope and marks it NOT a rate limit", () => {
    try {
      parseAlphaVantageEnvelope({
        "Error Message": "Invalid API call. Please retry or visit the documentation.",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      // A bad symbol must not be mistaken for quota exhaustion — the correct
      // response is to record a data error, not to degrade the whole run.
      expect((error as AlphaVantageApiError).isRateLimit).toBe(false);
    }
  });

  // This is the exact signature that proved `SECTOR` is retired (§5.8a).
  it("throws on an empty object, the signature of a retired endpoint", () => {
    expect(() => parseAlphaVantageEnvelope({})).toThrow(/retired or unavailable/);
  });

  it("rejects a non-object body", () => {
    expect(() => parseAlphaVantageEnvelope("just a string")).toThrow(/Expected a JSON object/);
    expect(() => parseAlphaVantageEnvelope(null)).toThrow(/Expected a JSON object/);
  });

  it("passes real data through untouched", () => {
    expect(parseAlphaVantageEnvelope(dailyIbm)).toBe(dailyIbm);
  });
});

// =============================================================================
describe("fetchEtfProfile — the authoritative weight source (§5.4, §5.8b)", () => {
  it("parses the real 105-holding QQQ fixture", async () => {
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));

    const profile = await fetchEtfProfile("QQQ");

    expect(profile.holdings).toHaveLength(105);
  });

  // The evidence for §5.8b: this is a FULL list, not Yahoo's top 10, which is
  // what keeps the `emerging_mover` quadrant reachable.
  it("includes small-weight constituents, not just the top 10", async () => {
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));

    const { holdings } = await fetchEtfProfile("QQQ");
    const smallest = Math.min(...holdings.map((h) => h.weight));

    // 0.11% — a name Yahoo's top-10 module would never surface, and exactly
    // the kind of company that can be an `emerging_mover`.
    expect(smallest).toBeLessThan(0.002);
  });

  it("coerces the string weights to real numbers", async () => {
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));

    const { holdings } = await fetchEtfProfile("QQQ");
    const nvda = holdings.find((h) => h.symbol === "NVDA")!;

    // Arrives as the string "0.0828"; must become the number 0.0828, or
    // downstream arithmetic silently concatenates instead of adding.
    expect(typeof nvda.weight).toBe("number");
    expect(nvda.weight).toBeCloseTo(0.0828, 4);
  });

  it("keeps weight as a FRACTION, matching Yahoo's convention (§5.8b)", async () => {
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));

    const { holdings } = await fetchEtfProfile("QQQ");

    // Every weight < 1. If a source ever switched to percent, this catches the
    // 100× scale error before it reaches a quadrant threshold.
    expect(holdings.every((h) => h.weight > 0 && h.weight < 1)).toBe(true);
  });

  it("weights sum to approximately 1", async () => {
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));

    const { holdings } = await fetchEtfProfile("QQQ");
    const total = holdings.reduce((sum, h) => sum + h.weight, 0);

    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });

  it("caches, so the 7-day TTL protects the 25/day budget", async () => {
    const stub = mockFetchJson(etfProfileQqq);
    vi.stubGlobal("fetch", stub);

    await fetchEtfProfile("QQQ");
    await fetchEtfProfile("QQQ");
    await fetchEtfProfile("QQQ");

    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rate-limit envelope as an AlphaVantageApiError", async () => {
    vi.stubGlobal("fetch", mockFetchJson(rateLimitNote));

    await expect(fetchEtfProfile("XLK")).rejects.toThrow(/demo|rate|limit/i);
  });

  it("does not cache a rate-limited response", async () => {
    vi.stubGlobal("fetch", mockFetchJson(rateLimitNote));

    await expect(fetchEtfProfile("XLK")).rejects.toThrow();
    // Caching an error would poison the entry for 7 days.
    expect(store.size()).toBe(0);
  });
});

// =============================================================================
describe("fetchDailySeries — the sector cross-check (§5.8a)", () => {
  it("parses the real 100-bar IBM fixture", async () => {
    vi.stubGlobal("fetch", mockFetchJson(dailyIbm));

    const bars = await fetchDailySeries("IBM");

    expect(bars).toHaveLength(100);
  });

  // ORDERING IS LOAD-BEARING. Alpha Vantage returns newest-first; Yahoo returns
  // oldest-first. If this normalisation were missing, every cross-checked %
  // change would have its SIGN FLIPPED — and would look like a genuine source
  // disagreement rather than an ordering bug.
  it("returns bars sorted OLDEST FIRST, matching Yahoo's ordering", async () => {
    vi.stubGlobal("fetch", mockFetchJson(dailyIbm));

    const bars = await fetchDailySeries("IBM");

    expect(bars[0]!.date).toBe("2026-03-10");
    expect(bars.at(-1)!.date).toBe("2026-07-31");
    expect(bars[0]!.date < bars.at(-1)!.date).toBe(true);
  });

  it("computes the correct sign of change from the normalised order", async () => {
    vi.stubGlobal("fetch", mockFetchJson(dailyIbm));

    const bars = await fetchDailySeries("IBM");
    const pctChange = ((bars.at(-1)!.close - bars[0]!.close) / bars[0]!.close) * 100;

    // IBM genuinely fell 10.61% across this window. A reversed sort would
    // report +11.9% here — plausible-looking and completely wrong.
    expect(pctChange).toBeCloseTo(-10.61, 1);
  });

  it("renames Alpha Vantage's numbered keys to plain field names", async () => {
    vi.stubGlobal("fetch", mockFetchJson(dailyIbm));

    const bars = await fetchDailySeries("IBM");

    expect(Object.keys(bars.at(-1)!).sort()).toEqual([
      "close",
      "date",
      "high",
      "low",
      "open",
      "volume",
    ]);
  });

  it("coerces every OHLCV field to a number", async () => {
    vi.stubGlobal("fetch", mockFetchJson(dailyIbm));

    const latest = (await fetchDailySeries("IBM")).at(-1)!;

    expect(latest.close).toBeCloseTo(223.65, 2);
    expect(latest.volume).toBe(9093613);
    expect(typeof latest.volume).toBe("number");
  });

  it("caches per symbol and output size", async () => {
    const stub = mockFetchJson(dailyIbm);
    vi.stubGlobal("fetch", stub);

    await fetchDailySeries("IBM");
    await fetchDailySeries("IBM");
    await fetchDailySeries("IBM", "full");

    // Two distinct queries → two calls; the repeat is served from cache.
    expect(stub).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
describe("Quota guard (§1 free-tier budget)", () => {
  it("permits a fan-out that fits the daily budget", () => {
    expect(hasQuotaFor(6)).toBe(true); // the §5.8a cross-check size
  });

  it("refuses a fan-out larger than the whole daily limit", () => {
    expect(hasQuotaFor(ALPHA_VANTAGE_DAILY_LIMIT + 1)).toBe(false);
  });

  it("accounts for calls already made this process", async () => {
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));
    await fetchEtfProfile("QQQ");

    // One call spent, so the remaining budget is one smaller.
    expect(hasQuotaFor(ALPHA_VANTAGE_DAILY_LIMIT)).toBe(false);
    expect(hasQuotaFor(ALPHA_VANTAGE_DAILY_LIMIT - 1)).toBe(true);
  });

  it("does not count cache hits against the budget", async () => {
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));
    await fetchEtfProfile("QQQ");
    await fetchEtfProfile("QQQ"); // served from cache

    expect(hasQuotaFor(ALPHA_VANTAGE_DAILY_LIMIT - 1)).toBe(true);
  });

  it("documents the free-tier ceiling from §5.2", () => {
    expect(ALPHA_VANTAGE_DAILY_LIMIT).toBe(25);
  });
});

// =============================================================================
describe("Configuration and transport errors (§8)", () => {
  it("gives an actionable message when the API key is missing", async () => {
    delete process.env["ALPHA_VANTAGE_API_KEY"];
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));

    await expect(fetchEtfProfile("XLK")).rejects.toThrow(/ALPHA_VANTAGE_API_KEY is not set/);
  });

  it("points at .env.example and the signup URL", async () => {
    process.env["ALPHA_VANTAGE_API_KEY"] = "";
    vi.stubGlobal("fetch", mockFetchJson(etfProfileQqq));

    await expect(fetchEtfProfile("XLK")).rejects.toThrow(/alphavantage\.co\/support/);
  });

  it("sends the key and function as query parameters", async () => {
    const stub = mockFetchJson(etfProfileQqq);
    vi.stubGlobal("fetch", stub);

    await fetchEtfProfile("XLK");

    const url = vi.mocked(stub).mock.calls[0]![0] as URL;
    expect(url.searchParams.get("function")).toBe("ETF_PROFILE");
    expect(url.searchParams.get("symbol")).toBe("XLK");
    expect(url.searchParams.get("apikey")).toBe("test-key-not-real");
  });

  it("wraps a genuine non-200 with source context", async () => {
    vi.stubGlobal("fetch", mockFetchJson({}, false, 503));

    await expect(fetchEtfProfile("XLK")).rejects.toThrow(
      /alpha_vantage\/ETF_PROFILE request failed/,
    );
  });

  it("rejects a structurally wrong response rather than passing it on", async () => {
    vi.stubGlobal("fetch", mockFetchJson({ holdings: "not-an-array" }));

    await expect(fetchEtfProfile("XLK")).rejects.toThrow(/failed validation/);
  });

  it("rejects a non-numeric weight like 'n/a'", async () => {
    vi.stubGlobal("fetch", mockFetchJson({ holdings: [{ symbol: "NVDA", weight: "n/a" }] }));

    await expect(fetchEtfProfile("XLK")).rejects.toThrow(/failed validation/);
  });
});
