/**
 * Coarse "Xm ago" label. Precision beyond minutes would be false confidence.
 *
 * Shared by `App.tsx` (breadcrumb / report freshness) and `HistoryModal.tsx`
 * (recent-thread timestamps) — split out so neither imports the other.
 */
export function relativeTimeLabel(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
