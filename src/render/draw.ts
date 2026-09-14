import type { Edge, EdgeKind, Paper, PaperId, Region, Visibility } from "../game/types";
import type { Theme } from "../theme";
import type { Layout, Node } from "./layout";
import {
  colorsFor,
  edgeStyle,
  regionFill,
  regionLabel,
  regionStroke,
  regionTint,
} from "./palette";

/**
 * Canvas painting.
 *
 * Kept free of React so the drawing rules stay independently readable: this
 * module knows how the world *looks*, and nothing about how it is stored or
 * when it changes.
 *
 * Draw order matters and is deliberate: region washes, then edges, then nodes,
 * then labels. Labels last because a title that disappears under a node is
 * worse than one that overlaps a line.
 */

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface DrawState {
  layout: Layout;
  theme: Theme;
  papers: Map<PaperId, Paper>;
  edges: Edge[];
  regions: Region[];
  visibility: Record<PaperId, Visibility>;
  /** Region ids the user has read something in. Drives wash intensity. */
  enteredRegions: Set<string>;
  camera: Camera;
  selectedId: PaperId | null;
  hoveredId: PaperId | null;
  /** Ids highlighted by the current search or lead selection. */
  highlighted: Set<PaperId>;
  edgeFilter: Record<EdgeKind, boolean>;
  focusRegion: string | null;
  /** Rising 0..1 clock for the beacon pulse. */
  time: number;
  /** Device pixel ratio, applied by the caller when sizing the canvas. */
  dpr: number;
}

/** Labels appear only when zoomed in enough to read them without collision. */
const LABEL_MIN_SCALE = 0.62;
/** Above this scale, even minor nodes get labels. */
const LABEL_ALL_SCALE = 1.5;

const isVisible = (v: Visibility | undefined): boolean => v !== undefined && v !== "fog";

/** Screen position of a world point under the current camera. */
export function worldToScreen(camera: Camera, x: number, y: number): [number, number] {
  return [(x - camera.x) * camera.scale, (y - camera.y) * camera.scale];
}

/** World position of a screen point. Used for hit-testing pointer events. */
export function screenToWorld(camera: Camera, sx: number, sy: number): [number, number] {
  return [sx / camera.scale + camera.x, sy / camera.scale + camera.y];
}

/**
 * Find the topmost node under a screen point.
 *
 * Iterates in reverse draw order so the node visually on top wins, and pads the
 * hit radius at low zoom because small targets are unfair to hit precisely.
 */
export function hitTest(state: DrawState, sx: number, sy: number): PaperId | null {
  const { layout, camera, visibility } = state;
  const [wx, wy] = screenToWorld(camera, sx, sy);
  // Generous at low zoom, tight when zoomed in.
  const pad = Math.max(3, 8 / camera.scale);

  let best: PaperId | null = null;
  let bestD = Infinity;
  for (const n of layout.nodes.values()) {
    if (!isVisible(visibility[n.id])) continue;
    const dx = wx - n.x;
    const dy = wy - n.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= n.r + pad && d < bestD) {
      best = n.id;
      bestD = d;
    }
  }
  return best;
}

function trimLabel(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 1 ? "" : `${text.slice(0, lo)}…`;
}

/** Should this node be dimmed because the user is focusing elsewhere? */
function dimFactor(state: DrawState, node: Node): number {
  const { focusRegion, highlighted, selectedId, hoveredId } = state;
  if (focusRegion && node.regionId !== focusRegion) return 0.18;
  // A non-empty highlight set means the user is searching; fade the rest so
  // matches stand out without hiding the surrounding structure.
  if (highlighted.size > 0 && !highlighted.has(node.id)) {
    return node.id === selectedId || node.id === hoveredId ? 0.7 : 0.22;
  }
  return 1;
}

export function draw(ctx: CanvasRenderingContext2D, state: DrawState, cssWidth: number, cssHeight: number): void {
  const { layout, papers, edges, regions, visibility, camera, edgeFilter } = state;
  const colors = colorsFor(state.theme);

  // Indexed once per frame. This runs inside the node loop, so a linear scan
  // here would cost regions x nodes comparisons sixty times a second.
  const regionById = new Map(regions.map((r) => [r.id, r]));

  ctx.save();
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

  // --- Background ---
  const bg = ctx.createLinearGradient(0, 0, 0, cssHeight);
  bg.addColorStop(0, colors.voidSoft);
  bg.addColorStop(1, colors.void);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // --- Region territories ---
  for (const region of regions) {
    const centre = layout.regionCentres.get(region.id);
    if (!centre) continue;
    // Only draw territory the user can actually see into.
    const anyVisible = region.members.some((id) => isVisible(visibility[id]));
    if (!anyVisible) continue;

    const entered = state.enteredRegions.has(region.id);
    const [cx, cy] = worldToScreen(camera, centre.x, centre.y);
    const r = centre.r * camera.scale;
    const faded = state.focusRegion && state.focusRegion !== region.id;

    ctx.globalAlpha = faded ? 0.25 : 1;
    const wash = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    wash.addColorStop(0, regionFill(region.hue, entered, state.theme));
    wash.addColorStop(1, "transparent");
    ctx.fillStyle = wash;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = regionStroke(region.hue, entered, state.theme);
    ctx.lineWidth = 1;
    // A dashed border marks territory you have never read anything in.
    ctx.setLineDash(entered ? [] : [4, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Territory name, drawn as background geography: large, faint, and behind
    // everything else. Naming the place is what lets the user think "I have
    // never been there" instead of just seeing an empty patch.
    const nameSize = Math.max(11, Math.min(22, r * 0.15));
    if (nameSize >= 11) {
      ctx.font = `600 ${nameSize}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = regionLabel(region.hue, entered, state.theme);
      ctx.fillText(region.name, cx, cy - r * 0.82);
      ctx.textAlign = "left";
    }
    ctx.globalAlpha = 1;
  }

  // --- Edges ---
  // Drawn under nodes, and only between two visible endpoints: an edge into the
  // fog would leak information about papers the user has not yet revealed.
  for (const edge of edges) {
    if (!edgeFilter[edge.kind]) continue;
    const a = layout.nodes.get(edge.source);
    const b = layout.nodes.get(edge.target);
    if (!a || !b) continue;
    const va = visibility[edge.source];
    const vb = visibility[edge.target];
    if (!isVisible(va) || !isVisible(vb)) continue;

    const style = edgeStyle(edge.kind);
    const dim = Math.min(dimFactor(state, a), dimFactor(state, b));
    // Edges touching the selection are emphasised: this is how the user reads
    // "what does this paper connect to?".
    const touchesSelection =
      state.selectedId !== null &&
      (edge.source === state.selectedId || edge.target === state.selectedId);

    const [ax, ay] = worldToScreen(camera, a.x, a.y);
    const [bx, by] = worldToScreen(camera, b.x, b.y);

    ctx.globalAlpha = style.alpha * dim * (touchesSelection ? 2.1 : 1);
    ctx.strokeStyle = touchesSelection
      ? colors.frontier
      : "#7189a8";
    ctx.lineWidth = style.width * (touchesSelection ? 1.8 : 1);
    ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // --- Nodes ---
  const labelled: Node[] = [];
  for (const node of layout.nodes.values()) {
    const v = visibility[node.id];
    if (!isVisible(v)) continue;
    const paper = papers.get(node.id);
    if (!paper) continue;

    const [x, y] = worldToScreen(camera, node.x, node.y);
    const r = Math.max(2, node.r * camera.scale);

    // Cull offscreen nodes; large libraries make this worth doing.
    if (x < -60 || y < -60 || x > cssWidth + 60 || y > cssHeight + 60) continue;

    const region = node.regionId ? regionById.get(node.regionId) : undefined;
    const hue = region?.hue ?? 220;
    const dim = dimFactor(state, node);
    const isSelected = node.id === state.selectedId;
    const isHovered = node.id === state.hoveredId;

    ctx.globalAlpha = dim;

    // Glow for anything that emits light. Beacons breathe slowly, which draws
    // the eye to the nodes that are actively widening the user's view.
    if (v === "lit" || v === "beacon") {
      const pulse = v === "beacon" ? 0.72 + Math.sin(state.time * 2.1) * 0.28 : 1;
      const glowR = r * (v === "beacon" ? 4.6 : 3.2) * pulse;
      const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, glowR);
      glow.addColorStop(0, v === "beacon" ? colors.beaconGlow : colors.litGlow);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (v === "lit" || v === "beacon") {
      ctx.fillStyle = regionTint(hue, v, state.theme);
      ctx.fill();
    } else {
      ctx.fillStyle =
        v === "frontier"
          ? "rgba(255, 255, 255, 0.86)"
          : "rgba(224, 232, 240, 0.72)";
      ctx.fill();
      ctx.strokeStyle =
        v === "frontier"
          ? `hsla(${hue}, 45%, 38%, 0.85)`
          : colors.sensed;
      ctx.lineWidth = v === "frontier" ? 1.4 : 1;
      // A dashed ring says "we know something is here, not what".
      if (v === "sensed") ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (isSelected || isHovered) {
      ctx.strokeStyle =
        isSelected
          ? colors.selection
          : "rgba(25, 52, 81, 0.56)";
      ctx.lineWidth = isSelected ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(x, y, r + (isSelected ? 5 : 3.5), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    // Collect for the label pass: named nodes only, and only when readable.
    const worthLabelling =
      v !== "sensed" &&
      (isSelected ||
        isHovered ||
        camera.scale >= LABEL_ALL_SCALE ||
        (camera.scale >= LABEL_MIN_SCALE && (v === "lit" || v === "beacon" || node.r > 9)));
    if (worthLabelling) labelled.push(node);
  }

  // --- Labels last, so nothing paints over them. ---
  ctx.font = "500 11.5px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  for (const node of labelled) {
    const paper = papers.get(node.id);
    if (!paper) continue;
    const v = visibility[node.id];
    const [x, y] = worldToScreen(camera, node.x, node.y);
    const r = Math.max(2, node.r * camera.scale);
    const dim = dimFactor(state, node);
    const emphasised = node.id === state.selectedId || node.id === state.hoveredId;

    const text = trimLabel(ctx, paper.title, emphasised ? 320 : 170);
    if (!text) continue;

    const tx = x + r + 6;
    ctx.globalAlpha = dim * (emphasised ? 1 : v === "lit" || v === "beacon" ? 0.9 : 0.6);

    // Halo so titles stay legible over edges and washes.
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(237, 243, 248, 0.92)";
    ctx.strokeText(text, tx, y);
    ctx.fillStyle = emphasised ? colors.ink : v === "lit" || v === "beacon" ? colors.ink : colors.inkMuted;
    ctx.fillText(text, tx, y);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
