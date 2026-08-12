/**
 * =============================================================================
 * SectorRankingsTable.tsx — the 11 GICS sectors, ranked, as clickable cells.
 * =============================================================================
 *
 * Presentational only (§8): it receives data and renders it. No fetching, no
 * business logic, no derived numbers.
 *
 * THE POINT OF SHOWING THIS GRID AT ALL
 * --------------------------------------
 * The prose report names a handful of sectors. This grid shows ALL of them
 * with the exact figures the deterministic nodes computed, so a reader can
 * check the narrative against its source. That is the visible half of §1's
 * guarantee — the numbers in the report are not the model's, and here they are
 * to prove it.
 *
 * The source label on each cell matters for the same reason the old table's
 * "Source" column did. `cross_checked` means two independent providers agreed
 * on that figure; `yahoo_finance` means only one was available. Hiding that
 * distinction would present both with equal confidence, which §5.3 is at pains
 * to avoid.
 *
 * WHY A GRID INSTEAD OF ROWS
 * --------------------------
 * `sectorRankings` always covers all 11 GICS sectors (the trend node ranks
 * every one; only the leader lookup is restricted to the top/bottom N), so
 * there is no long tail to hide behind a "show more" toggle the way the old
 * row-table needed. Each cell is also the sector selector for the leaders
 * panel below — clicking a sector here is how a reader moves from "what
 * happened" to "who did it".
 */

import type { SectorRanking } from "../api/client.js";
import { formatPctChange } from "./quadrant.js";

export interface SectorRankingsTableProps {
  rankings: SectorRanking[];
  /** The window these figures cover, e.g. "1mo". Shown in the heading. */
  timeWindow: string;
  /** The sector currently shown in the leaders panel below. */
  activeSector: string | null;
  /** Selects a sector — drives both this grid's highlight and the leaders panel. */
  onSelectSector: (sector: string) => void;
}

const SOURCE_LABEL: Record<SectorRanking["source"], string> = {
  cross_checked: "verified",
  alpha_vantage: "alpha vantage",
  yahoo_finance: "yahoo only",
};

const SOURCE_TITLE: Record<SectorRanking["source"], string> = {
  cross_checked: "Yahoo Finance and Alpha Vantage agreed on this figure within tolerance.",
  alpha_vantage: "Figure from Alpha Vantage only.",
  yahoo_finance:
    "Figure from Yahoo Finance only — no second source was available to cross-check it.",
};

export function SectorRankingsTable({
  rankings,
  timeWindow,
  activeSector,
  onSelectSector,
}: SectorRankingsTableProps) {
  if (rankings.length === 0) {
    return (
      <section>
        <h6 style={{ marginBottom: "var(--space-3)" }}>Sector Rankings</h6>
        <p className="text-muted sfs-empty">No sector data was available for this request.</p>
      </section>
    );
  }

  // Most positive to most negative — §5.3's contract for `sectorRankings`.
  const sorted = [...rankings].sort((a, b) => b.pctChange - a.pctChange);

  return (
    <section>
      <h6 style={{ marginBottom: "var(--space-3)" }}>Sector Rankings · {timeWindow}</h6>
      <div className="sfs-sector-grid" role="list">
        {sorted.map((row) => {
          const up = row.pctChange >= 0;
          const isActive = row.sector === activeSector;
          return (
            <button
              key={row.sector}
              type="button"
              role="listitem"
              className={`sfs-sector-cell${isActive ? " sfs-sector-cell-active" : ""}`}
              onClick={() => onSelectSector(row.sector)}
              aria-pressed={isActive}
            >
              <div className="sfs-sector-cell-name">{row.sector}</div>
              <div className="sfs-sector-cell-figure">
                <span className={`sfs-sector-cell-arrow ${up ? "sfs-up" : "sfs-down"}`}>
                  {up ? "▲" : "▼"}
                </span>
                <span className={`sfs-sector-cell-pct ${up ? "sfs-up" : "sfs-down"}`}>
                  {formatPctChange(row.pctChange)}
                </span>
              </div>
              <div
                className="sfs-sector-cell-source text-muted"
                title={SOURCE_TITLE[row.source]}
              >
                {SOURCE_LABEL[row.source]}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
