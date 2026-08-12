/**
 * =============================================================================
 * DataNotesPanel.tsx — degradation notes, shown rather than swallowed.
 * =============================================================================
 *
 * WHY THIS COMPONENT EXISTS AT ALL
 * --------------------------------
 * It would be easy to drop `dataErrors` and `trendDataErrors` on the floor and
 * show a clean-looking report. That would be the single most misleading thing
 * this UI could do, because those arrays are where the whole pipeline records
 * that an answer is INCOMPLETE:
 *
 *   - "sources disagree — Yahoo 8.33% vs Alpha Vantage 14.00%" (§5.3)
 *   - "emerging_mover suppressed for AVGO — only top-10 holdings available" (§5.9b)
 *   - "Alpha Vantage quota exhausted; using Yahoo Finance only" (§5.7)
 *   - "NVDA listed 2026-07-20, after the window opened — excluded from speed"
 *
 * Every one of those is the system declining to make a confident claim it
 * cannot support. Hiding them would undo that honesty at the last step, and it
 * is the same principle §5.3 states for source disagreements: a stated caveat
 * is honest, a silent one is not.
 *
 * Presentational only (§8). Collapsed by default so it does not dominate a
 * healthy run, but the count is always visible in the summary.
 */

export interface DataNotesPanelProps {
  /** Capability-specific degradation notes (industry-trend). */
  trendDataErrors: string[];
  /** Problems not attributable to one capability. */
  dataErrors: string[];
}

export function DataNotesPanel({ trendDataErrors, dataErrors }: DataNotesPanelProps) {
  const total = trendDataErrors.length + dataErrors.length;

  // Nothing to report is the good case — render nothing rather than an empty
  // panel that implies something is missing.
  if (total === 0) return null;

  return (
    <section className="card">
      <details>
        <summary style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span style={{ fontWeight: 600 }}>Data notes</span>
          <span className="tag tag-accent">{total}</span>
          <span className="text-muted" style={{ fontSize: "12px" }}>
            Where the analysis was incomplete or a figure could not be verified.
          </span>
        </summary>

        {dataErrors.length > 0 && (
          <>
            <h6 style={{ marginTop: "var(--space-4)" }}>General</h6>
            <ul className="text-muted sfs-note-list">
              {dataErrors.map((note, i) => (
                <li key={`d-${i}`}>{note}</li>
              ))}
            </ul>
          </>
        )}

        {trendDataErrors.length > 0 && (
          <>
            <h6 style={{ marginTop: "var(--space-4)" }}>Sector analysis</h6>
            <ul className="text-muted sfs-note-list">
              {trendDataErrors.map((note, i) => (
                <li key={`t-${i}`}>{note}</li>
              ))}
            </ul>
          </>
        )}
      </details>
    </section>
  );
}
