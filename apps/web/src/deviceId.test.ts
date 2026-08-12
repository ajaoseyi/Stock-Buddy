/**
 * tests for deviceId.ts
 *
 * The Vitest environment for this workspace is plain Node (vitest.config.ts),
 * which has no `localStorage` global at all — confirmed empirically, it's not
 * merely `undefined`, referencing the bare identifier throws a
 * `ReferenceError`. That is exactly the condition `getDeviceId()`'s fallback
 * exists for, so these tests stub a minimal in-memory `localStorage` to cover
 * the persisted path, and rely on the real (absent) global to cover the
 * fallback path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeviceId, resetDeviceIdForTesting } from "./deviceId.js";

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetDeviceIdForTesting();
});

describe("getDeviceId — with localStorage available", () => {
  it("creates and persists a UUID on first call", () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);

    const id = getDeviceId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(storage.getItem("sfs-device-id")).toBe(id);
  });

  it("returns the same id across calls in the same session", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());

    expect(getDeviceId()).toBe(getDeviceId());
  });

  it("reads back a previously stored id rather than generating a new one", () => {
    const storage = fakeLocalStorage();
    storage.setItem("sfs-device-id", "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("localStorage", storage);

    expect(getDeviceId()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("a fresh browser (different storage) gets a different id", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    const first = getDeviceId();

    resetDeviceIdForTesting();
    vi.stubGlobal("localStorage", fakeLocalStorage());
    const second = getDeviceId();

    expect(first).not.toBe(second);
  });
});

describe("getDeviceId — localStorage unavailable", () => {
  it("still returns a UUID rather than throwing", () => {
    // No stub: this workspace's Node test environment has no `localStorage`
    // global at all, which is exactly the failure this fallback covers.
    expect(() => getDeviceId()).not.toThrow();
    expect(getDeviceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("still caches within the session even though nothing persists", () => {
    expect(getDeviceId()).toBe(getDeviceId());
  });
});
