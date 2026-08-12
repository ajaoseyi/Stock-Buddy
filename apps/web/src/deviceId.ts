/**
 * =============================================================================
 * deviceId.ts — anonymous per-browser identity, no auth system.
 * =============================================================================
 *
 * CLAUDE.md §7.2: there is no login, no session, no server-side account. A
 * `crypto.randomUUID()` is generated once per browser, kept in `localStorage`,
 * and sent as `X-Device-Id` on every request (see `api/client.ts`). The server
 * uses it only to decide which device's `GET /api/threads` list a thread shows
 * up in — it is NOT a security boundary, exactly like the thread-id UUID it
 * sits alongside: anyone holding a thread's URL can still open it directly.
 *
 * WHY NOT "ENCRYPT" IT
 * ---------------------
 * A v4 UUID already has 122 bits of entropy — that unguessability is the whole
 * property this needs. "Encrypting" it would require a key stored somewhere
 * the browser can reach, which secures nothing: anyone who can read the
 * encrypted value can also read the key that decrypts it. A plain random UUID
 * is the stronger, simpler choice.
 */

const STORAGE_KEY = "sfs-device-id";

let cached: string | null = null;

/**
 * The current browser's device id, creating and persisting one on first call.
 *
 * Cached in module state after the first read so repeated calls within a
 * session don't round-trip through `localStorage`. Falls back to a
 * session-only id (not persisted) if `localStorage` is unavailable — private
 * browsing modes and some embedded webviews throw on access rather than
 * returning `null`, and a device id that fails to send is worse than one that
 * doesn't survive a refresh.
 */
export function getDeviceId(): string {
  if (cached !== null) return cached;

  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing !== null && existing !== "") {
      cached = existing;
      return cached;
    }

    const created = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, created);
    cached = created;
    return cached;
  } catch {
    cached = crypto.randomUUID();
    return cached;
  }
}

/** Test-only: clear the module-level cache so a test can simulate a fresh browser. */
export function resetDeviceIdForTesting(): void {
  cached = null;
}
