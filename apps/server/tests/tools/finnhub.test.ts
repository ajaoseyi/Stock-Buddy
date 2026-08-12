/**
 * =============================================================================
 * tests/tools/finnhub.test.ts
 * =============================================================================
 *
 * ⚠️ FIXTURE PROVENANCE. Unlike the Yahoo and Alpha Vantage fixtures, which are
 * verbatim captures of real responses, `finnhub-profile2-nvda.json` is
 * SYNTHETIC — Finnhub offers no demo key, so it was constructed from the
 * documented `stock/profile2` shape. It should be replaced with a real capture
 * once a key is available:
 *
 *     FINNHUB_API_KEY=<key> node tests/fixtures/capture.mjs finnhub
 *
 * The tests below are written to survive that swap: they assert on field
 * SEMANTICS (units, optionality, the IPO cutoff rule) rather than on exact
 * values that a real capture would change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FINNHUB_RATE_LIMIT_PER_MINUTE,
  fetchCompanyProfile,
  hasSufficientHistory,
  marketCapAbsolute,
} from "../../src/tools/finnhub.js";
import { CacheStore, resetApiCallCounts, setCacheForTesting } from "../../src/tools/cache.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const nvdaProfile = JSON.parse(
  readFileSync(join(FIXTURES, "finnhub-profile2-nvda.json"), "utf8"),
) as Record<string, unknown>;

let store: CacheStore;

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  store = new CacheStore(":memory:");
  setCacheForTesting(store);
  resetApiCallCounts();
  delete process.env["CACHE_BYPASS"];
  process.env["FINNHUB_API_KEY"] = "test-key-not-real";
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
describe("fetchCompanyProfile", () => {
  it("parses a profile response", async () => {
    vi.stubGlobal("fetch", mockFetchJson(nvdaProfile));

    const profile = await fetchCompanyProfile("NVDA");

    expect(profile?.ticker).toBe("NVDA");
    expect(profile?.finnhubIndustry).toBe("Semiconductors");
  });

  it("sends the symbol and token as query parameters", async () => {
    const stub = mockFetchJson(nvdaProfile);
    vi.stubGlobal("fetch", stub);

    await fetchCompanyProfile("NVDA");

    const url = vi.mocked(stub).mock.calls[0]![0] as URL;
    expect(url.pathname).toContain("/stock/profile2");
    expect(url.searchParams.get("symbol")).toBe("NVDA");
    expect(url.searchParams.get("token")).toBe("test-key-not-real");
  });

  // The documented quirk: an unknown symbol is HTTP 200 + `{}`, not a 404.
  it("returns null for an unknown symbol rather than throwing", async () => {
    vi.stubGlobal("fetch", mockFetchJson({}));

    // §5.7/§8: an unrecognised ticker inside an ETF's holdings is a data gap to
    // note, not a reason to fail the whole sector.
    await expect(fetchCompanyProfile("NOTAREALTICKER")).resolves.toBeNull();
  });

  it("tolerates a sparse profile with most fields missing", async () => {
    // Real Finnhub coverage varies — ADRs and recent listings routinely omit
    // ipo/logo/marketCapitalization. Requiring them would drop the company
    // from the analysis entirely, which is far worse than not knowing its
    // IPO date.
    vi.stubGlobal("fetch", mockFetchJson({ ticker: "XYZ", name: "Example Corp" }));

    const profile = await fetchCompanyProfile("XYZ");

    expect(profile?.ticker).toBe("XYZ");
    expect(profile?.ipo).toBeUndefined();
    expect(profile?.marketCapitalization).toBeUndefined();
  });

  it("caches indefinitely — one call per ticker, ever", async () => {
    const stub = mockFetchJson(nvdaProfile);
    vi.stubGlobal("fetch", stub);

    for (let i = 0; i < 5; i++) await fetchCompanyProfile("NVDA");

    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("caches per ticker, not globally", async () => {
    const stub = mockFetchJson(nvdaProfile);
    vi.stubGlobal("fetch", stub);

    await fetchCompanyProfile("NVDA");
    await fetchCompanyProfile("AMD");

    expect(stub).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
describe("HTTP error handling (§8)", () => {
  it("gives an actionable message when the key is missing", async () => {
    delete process.env["FINNHUB_API_KEY"];
    vi.stubGlobal("fetch", mockFetchJson(nvdaProfile));

    await expect(fetchCompanyProfile("NVDA")).rejects.toThrow(/FINNHUB_API_KEY is not set/);
  });

  it("explains a 401 as a rejected key rather than a generic failure", async () => {
    vi.stubGlobal("fetch", mockFetchJson({}, 401));

    await expect(fetchCompanyProfile("NVDA")).rejects.toThrow(/FINNHUB_API_KEY was rejected/);
  });

  it("names the free-tier limit in the 429 message", async () => {
    vi.stubGlobal("fetch", mockFetchJson({}, 429));

    await expect(fetchCompanyProfile("NVDA")).rejects.toThrow(/rate limit exceeded/);
    await expect(fetchCompanyProfile("NVDA")).rejects.toThrow(/60\/min/);
  });

  it("wraps transport failures with source context", async () => {
    vi.stubGlobal("fetch", mockFetchJson({}, 503));

    await expect(fetchCompanyProfile("NVDA")).rejects.toThrow(
      /finnhub\/stock\/profile2 request failed/,
    );
  });

  it("documents the free-tier rate limit from §5.2", () => {
    expect(FINNHUB_RATE_LIMIT_PER_MINUTE).toBe(60);
  });
});

// =============================================================================
describe("hasSufficientHistory — the recent-IPO rule (§5.7)", () => {
  const windowStart = new Date("2026-05-01T00:00:00Z");

  it("accepts a company listed long before the window", () => {
    expect(hasSufficientHistory({ ipo: "1999-01-22" }, windowStart)).toBe(true);
  });

  // The core of §5.7's first edge case.
  it("rejects a company that listed AFTER the window opened", () => {
    // A partial-window return is not measuring the same thing as a full-window
    // one. Including it would drag the mean and standard deviation that every
    // OTHER constituent's z-scored speed is computed against — corrupting the
    // whole sector's ranking, not just this one row.
    expect(hasSufficientHistory({ ipo: "2026-06-15" }, windowStart)).toBe(false);
  });

  it("accepts a company that listed exactly on the window start", () => {
    expect(hasSufficientHistory({ ipo: "2026-05-01" }, windowStart)).toBe(true);
  });

  // Deliberate policy, documented on the function: unknown counts as
  // sufficient. Excluding every company whose IPO date Finnhub happens not to
  // carry would silently shrink the peer set and bias the z-scores — a worse
  // error than occasionally including one short series.
  it("treats an unknown IPO date as sufficient", () => {
    expect(hasSufficientHistory({}, windowStart)).toBe(true);
    expect(hasSufficientHistory({ ipo: "" }, windowStart)).toBe(true);
  });

  it("treats an unparseable IPO date as unknown rather than throwing", () => {
    expect(hasSufficientHistory({ ipo: "not-a-date" }, windowStart)).toBe(true);
  });

  it("treats a null profile as sufficient", () => {
    expect(hasSufficientHistory(null, windowStart)).toBe(true);
  });

  it("scales with the window — a longer lookback excludes more companies", () => {
    const oneYear = new Date("2025-08-01T00:00:00Z");
    const oneMonth = new Date("2026-07-01T00:00:00Z");
    const listedInJanuary = { ipo: "2026-01-15" };

    // The same company qualifies for a 1-month window but not a 1-year one,
    // which is exactly the scenario §5.7 describes.
    expect(hasSufficientHistory(listedInJanuary, oneYear)).toBe(false);
    expect(hasSufficientHistory(listedInJanuary, oneMonth)).toBe(true);
  });
});

// =============================================================================
describe("marketCapAbsolute — the flagged weight fallback (§5.4)", () => {
  // The unit trap: Finnhub reports millions. Forgetting to convert produces a
  // number wrong by 1,000,000× that still looks entirely plausible.
  it("converts from Finnhub's millions to absolute units", () => {
    expect(marketCapAbsolute({ marketCapitalization: 4_231_500 })).toBe(4_231_500_000_000);
  });

  it("returns null when market cap is unavailable", () => {
    expect(marketCapAbsolute({})).toBeNull();
    expect(marketCapAbsolute(null)).toBeNull();
  });

  it("returns null for a non-finite value instead of propagating NaN", () => {
    // NaN would silently poison every downstream weight comparison.
    expect(marketCapAbsolute({ marketCapitalization: Number.NaN })).toBeNull();
    expect(marketCapAbsolute({ marketCapitalization: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("preserves relative ordering, which is all the fallback needs", () => {
    const big = marketCapAbsolute({ marketCapitalization: 4_231_500 })!;
    const small = marketCapAbsolute({ marketCapitalization: 120_000 })!;

    expect(big).toBeGreaterThan(small);
  });
});
