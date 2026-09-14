import type { EdgeKind } from "../game/types";
import { EDGE_LABELS } from "../render/palette";
import { useStore } from "../state/store";

/**
 * Map key, doubling as the relation filter.
 *
 * Merging the legend and the filter is deliberate: the thing that explains what
 * a line means is also the thing that turns it off, so there is no separate
 * settings surface to hunt for. Clicking a kind you do not trust removes it
 * from the map immediately.
 */

const KINDS: EdgeKind[] = ["cites", "coauthor", "keyword", "venue", "manual"];

export default function MapLegend() {
  const edgeFilter = useStore((s) => s.edgeFilter);
  const toggleEdgeKind = useStore((s) => s.toggleEdgeKind);
  const stats = useStore((s) => s.world.stats);

  if (stats.known === 0) return null;

  return (
    <div className="map-legend">
      <span style={{ color: "var(--lit)" }}>● 已读</span>
      <span style={{ color: "var(--beacon)" }}>◉ 灯塔</span>
      <span style={{ color: "var(--frontier)" }}>○ 视野边缘</span>
      <span style={{ color: "var(--ink-faint)" }}>◌ 隐约可见</span>

      {KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={edgeFilter[kind]}
          onClick={() => toggleEdgeKind(kind)}
          title={`显示或隐藏「${EDGE_LABELS[kind]}」关系`}
        >
          <span className={`dash dash-${kind}`} />
          {EDGE_LABELS[kind]}
        </button>
      ))}
    </div>
  );
}
