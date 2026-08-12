/**
 * =============================================================================
 * HistoryModal.tsx — recent conversations on this device (§7.2).
 * =============================================================================
 *
 * Presentational + its own data fetch, matching `LeaderDrilldown`'s pattern
 * for a dialog that appears above the main view. Fetches on open rather than
 * receiving data as a prop, because "recent history" is a query worth
 * re-running every time the modal opens, not state `App` needs to hold
 * continuously.
 *
 * Backed by `GET /api/threads`, scoped to this browser's anonymous device id
 * (`deviceId.ts`) — a different browser, or this one with `localStorage`
 * cleared, has nothing to show here. That is the honest behaviour of a scheme
 * with no server-side account (§7.2), not a bug.
 */

import { useEffect, useState } from "react";
import { deleteThread, listRecentThreads, type RecentThread } from "../api/client.js";
import { relativeTimeLabel } from "../relativeTime.js";

export interface HistoryModalProps {
  onClose: () => void;
  /** Navigate to this thread's report and close the modal. */
  onSelectThread: (threadId: string) => void;
  /** Highlighted in the list so the reader can tell which conversation they're already in. */
  currentThreadId: string | null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function HistoryModal({ onClose, onSelectThread, currentThreadId }: HistoryModalProps) {
  const [threads, setThreads] = useState<RecentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    listRecentThreads()
      .then((result) => {
        if (!cancelled) setThreads(result);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The list is fetched once per open, but "5m ago" would otherwise freeze at
  // whatever it read on load if the modal is left open for a while.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const handleDelete = (threadId: string) => {
    // Optimistic removal — the modal is not the record of truth, the server
    // is, and a failed delete is rare enough not to warrant blocking the UI
    // on a round trip before the row disappears.
    const previous = threads;
    setThreads((current) => (current ?? []).filter((t) => t.threadId !== threadId));
    setDeletingId(threadId);

    deleteThread(threadId)
      .catch((caught) => {
        // §8: a caught failure must degrade visibly, not silently. Restore the
        // row and surface why, rather than leaving the list quietly wrong.
        setThreads(previous);
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setDeletingId(null));
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div className="dialog-title">Recent conversations</div>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error !== null && (
          <p className="text-muted dialog-body" style={{ color: "var(--color-accent-700)" }}>
            {error}
          </p>
        )}

        {threads === null && error === null && (
          <p className="text-muted dialog-body">Loading…</p>
        )}

        {threads !== null && threads.length === 0 && (
          <p className="text-muted dialog-body">
            No conversations yet on this device. Ask a question to start one.
          </p>
        )}

        {threads !== null && threads.length > 0 && (
          <div className="sfs-history-list">
            {threads.map((thread) => (
              <div
                key={thread.threadId}
                className={`sfs-history-row${thread.threadId === currentThreadId ? " sfs-history-row-current" : ""}`}
              >
                <button
                  type="button"
                  className="sfs-history-row-main"
                  onClick={() => onSelectThread(thread.threadId)}
                >
                  <span className="sfs-history-row-query">{truncate(thread.lastQuery, 60)}</span>
                  <span className="text-muted sfs-history-row-time">
                    {relativeTimeLabel(thread.updatedAt, now)}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => handleDelete(thread.threadId)}
                  disabled={deletingId === thread.threadId}
                  aria-label={`Delete conversation: ${thread.lastQuery}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
