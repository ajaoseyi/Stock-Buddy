/**
 * =============================================================================
 * LeaderDrilldown.tsx — one company's weight/speed/volume, against its peers.
 * =============================================================================
 *
 * Presentational only (§8). Every figure it shows is read straight off the
 * `SectorLeader` the caller already has — this component positions three bars
 * within [min, max] of the SAME sector's peers, and that is the only
 * arithmetic here. It never compares one company's weight against another
 * company's speed, and it never produces a new score (§5.4, §9).
 *
 * Opened from three places, uniformly: a narrative token in the report
 * (`ReportView`), a quadrant-chart dot or table row (`SectorLeadersPanel`), or
 * the narrow-viewport leader list. All three call `onOpenDrilldown(ticker)` up
 * to `App`, which owns `drilldownTicker` — a single source of truth means the
 * dialog behaves identically no matter which entry point opened it.
 */

import type { SectorLeader } from "../api/client.js";
import { QUADRANT_COLORS, QUADRANT_LABELS, formatRelativeVolume, formatSpeed, formatWeight } from "./quadrant.js";

export interface LeaderDrilldownProps {
  /** Full leader map, so a ticker can be found regardless of which sector tab is active. */
  leaders: Record<string, SectorLeader[]>;
  ticker: string;
  onClose: () => void;
}

interface MetricRow {
  label: string;
  valueLabel: string;
  barPct: number;
  rangeLabel: string;
}

function metricRow(
  label: string,
  value: number,
  peers: number[],
  format: (v: number) => string,
): MetricRow {
  const min = Math.min(...peers);
  const max = Math.max(...peers);
  const pct = max === min ? 50 : ((value - min) / (max - min)) * 100;
  return {
    label,
    valueLabel: format(value),
    barPct: pct,
    rangeLabel: `Sector range: ${format(min)} – ${format(max)}`,
  };
}

export function LeaderDrilldown({ leaders, ticker, onClose }: LeaderDrilldownProps) {
  let found: SectorLeader | null = null;
  let sectorName: string | null = null;
  let peers: SectorLeader[] = [];

  for (const [sector, rows] of Object.entries(leaders)) {
    const match = rows.find((row) => row.ticker === ticker);
    if (match !== undefined) {
      found = match;
      sectorName = sector;
      peers = rows;
      break;
    }
  }

  // A narrative token can name a ticker that fell out of `sectorLeaders` — e.g.
  // it was excluded from speed ranking (§5.7) but the prose still mentions it
  // in passing. Closing silently would be a dead click; saying so is honest.
  if (found === null || sectorName === null) {
    return (
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog" onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div className="dialog-title">{ticker}</div>
            <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
          <p className="text-muted dialog-body">
            No computed leader data for {ticker} in this report — it may have been excluded from
            ranking. Check the data notes below.
          </p>
        </div>
      </div>
    );
  }

  const leader = found;
  const metrics = [
    metricRow(
      "Weight score (ETF disclosed weight)",
      leader.weightScore,
      peers.map((p) => p.weightScore),
      formatWeight,
    ),
    metricRow(
      "Speed score (momentum vs sector peers)",
      leader.speedScore,
      peers.map((p) => p.speedScore),
      formatSpeed,
    ),
    metricRow(
      "Relative volume",
      leader.relativeVolume,
      peers.map((p) => p.relativeVolume),
      formatRelativeVolume,
    ),
  ];

  const speedRank =
    [...peers].sort((a, b) => b.speedScore - a.speedScore).findIndex((p) => p.ticker === leader.ticker) +
    1;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="dialog-title">{leader.ticker}</div>
            <div className="text-muted" style={{ fontSize: "12.5px", marginTop: "2px" }}>
              {sectorName} ·{" "}
              <span style={{ color: QUADRANT_COLORS[leader.quadrant] }}>
                {QUADRANT_LABELS[leader.quadrant]}
              </span>
            </div>
          </div>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {metrics.map((metric) => (
          <div key={metric.label}>
            <div className="sfs-metric-head">
              <span className="text-muted">{metric.label}</span>
              <span className="sfs-metric-value">{metric.valueLabel}</span>
            </div>
            <div className="sfs-metric-track">
              <div
                className="sfs-metric-fill"
                style={{ width: `${metric.barPct}%`, background: QUADRANT_COLORS[leader.quadrant] }}
              />
            </div>
            <div className="text-muted sfs-metric-range">{metric.rangeLabel}</div>
          </div>
        ))}

        <hr className="hr" style={{ margin: "var(--space-1) 0" }} />
        <div className="text-muted sfs-dialog-foot">
          #{speedRank} of {peers.length} by speed score in {sectorName}.
        </div>
      </div>
    </div>
  );
}
