import type { Edge, Paper, PaperId, Region } from "../game/types";

/**
 * Map layout.
 *
 * A force-directed layout, with one important departure from the textbook
 * version: papers are anchored toward their region's territory. A pure force
 * simulation produces a hairball whose shape changes every time you open the
 * app, which is useless as a *map* — you cannot build a mental picture of
 * somewhere that never looks the same twice.
 *
 * So: regions get fixed positions on a ring derived from their id, and papers
 * are pulled toward their own region's centre. The result is stable across
 * sessions, and the same corpus always lays out the same way.
 *
 * The simulation is *steppable*. Settling a thousand papers takes a couple of
 * seconds, and doing that in one call freezes the window; instead the caller
 * advances it a few iterations per frame, so the map visibly settles into place
 * and stays interactive throughout.
 */

export interface Node {
  id: PaperId;
  x: number;
  y: number;
  /** Velocity, carried between ticks so the simulation can settle. */
  vx: number;
  vy: number;
  /** Drawn radius, from citation count. */
  r: number;
  regionId: string | null;
  /** Anchor for the region pull. */
  ax: number;
  ay: number;
  /**
   * Pinned nodes are not moved by the simulation; they stay where the user
   * dragged them while still exerting repulsion on other nodes.
   */
  pinned: boolean;
}

/** A relation strong enough to pull on the layout. */
interface Spring {
  a: Node;
  b: Node;
  w: number;
}

export interface Layout {
  nodes: Map<PaperId, Node>;
  /** Region centres, for drawing territory labels and washes. */
  regionCentres: Map<string, { x: number; y: number; r: number }>;
  width: number;
  height: number;
  /** Iterations applied so far. */
  iterations: number;
  /** Iterations that constitute a full settle. */
  target: number;
  /** True once `iterations` reaches `target`; the map has stopped moving. */
  settled: boolean;
  /**
   * Cached spring set. Held on the layout so stepping does not rebuild it every
   * frame — with ~20k edges that rebuild would cost more than the physics.
   */
  springs: Spring[];
  /** Node list in stable order, cached for the same reason. */
  order: Node[];
}

/** Deterministic PRNG (mulberry32) so initial placement is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash, used to seed both placement and region angles. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- Tuning. These were chosen for readability at 60-1000 nodes. ---
const ITERATIONS = 400;
const REPULSION = 120000;
const SPRING = 0.035;
const REGION_PULL = 0.030;
const CENTER_PULL = 0.0012;
const DAMPING = 0.82;
/** Cells this size make repulsion O(n) in practice instead of O(n^2). */
const GRID = 90;
/** Ignore repulsion past this distance; distant nodes barely contribute. */
const REPULSION_CUTOFF = 350;
/** Below this weight a relation is too weak to shape the map. */
const SPRING_FLOOR = 0.3;

/** Node radius from citation count. Log-scaled: impact spans 5 magnitudes. */
export function radiusFor(paper: Paper): number {
  const base = 4.5;
  if (paper.citedByCount <= 0) return base;
  return base + Math.min(11, Math.log10(paper.citedByCount + 1) * 3.1);
}

/**
 * Place region centres on a ring, ordered by size so the biggest territories
 * get the most room, but angled by id hash so a region keeps its bearing even
 * as the corpus grows around it.
 */
function placeRegions(
  regions: Region[],
  width: number,
  height: number,
): Map<string, { x: number; y: number; r: number }> {
  const cx = width / 2;
  const cy = height / 2;
  const ringR = Math.min(width, height) * 0.31;
  const centres = new Map<string, { x: number; y: number; r: number }>();

  if (regions.length === 0) return centres;
  if (regions.length === 1) {
    centres.set(regions[0].id, { x: cx, y: cy, r: ringR });
    return centres;
  }

  // Order by member count, then id, so the arrangement is deterministic.
  const ordered = [...regions].sort(
    (a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1),
  );

  const total = ordered.reduce((n, r) => n + Math.max(1, r.members.length), 0);
  let angle = (hash(ordered[0].id) % 360) * (Math.PI / 180);

  for (const region of ordered) {
    const share = Math.max(1, region.members.length) / total;
    // Sweep proportional to size, so crowded regions are not squeezed.
    const sweep = share * Math.PI * 2;
    const mid = angle + sweep / 2;
    centres.set(region.id, {
      x: cx + Math.cos(mid) * ringR,
      y: cy + Math.sin(mid) * ringR,
      // Territory radius grows with membership but stays bounded.
      r: Math.max(70, Math.min(230, 42 + Math.sqrt(region.members.length) * 30)),
    });
    angle += sweep;
  }
  return centres;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** Previous layout; positions are reused so the map does not jump. */
  previous?: Layout | null;
  iterations?: number;
}

/**
 * Seed a layout without running any physics.
 *
 * Returns immediately, so the first frame can be drawn at once and the
 * simulation settled progressively via `advanceLayout`.
 */
export function createLayout(
  papers: Paper[],
  edges: Edge[],
  regions: Region[],
  opts: LayoutOptions = {},
): Layout {
  const width = opts.width ?? 1600;
  const height = opts.height ?? 1000;
  const target = opts.iterations ?? ITERATIONS;

  const regionCentres = placeRegions(regions, width, height);
  const regionOf = new Map<PaperId, string>();
  for (const r of regions) for (const id of r.members) regionOf.set(id, r.id);

  // --- Seed positions: reuse where we can, else scatter inside the region. ---
  const nodes = new Map<PaperId, Node>();
  for (const p of papers) {
    const regionId = regionOf.get(p.id) ?? null;
    const centre = regionId ? regionCentres.get(regionId) : undefined;
    const ax = centre?.x ?? width / 2;
    const ay = centre?.y ?? height / 2;

    const prior = opts.previous?.nodes.get(p.id);
    if (prior) {
      nodes.set(p.id, { ...prior, r: radiusFor(p), regionId, ax, ay, pinned: false });
      continue;
    }

    // Deterministic scatter within the territory, seeded by paper id.
    const rand = rng(hash(p.id));
    const spread = (centre?.r ?? 220) * 0.75;
    const angle = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * spread;
    nodes.set(p.id, {
      id: p.id,
      x: ax + Math.cos(angle) * dist,
      y: ay + Math.sin(angle) * dist,
      vx: 0,
      vy: 0,
      r: radiusFor(p),
      regionId,
      ax,
      ay,
      pinned: false,
    });
  }

  // Only edges strong enough to matter pull on the layout; weak ones would
  // drag every cluster together and flatten the map's structure.
  const springs: Spring[] = [];
  for (const e of edges) {
    if (e.weight < SPRING_FLOOR) continue;
    const a = nodes.get(e.source);
    const b = nodes.get(e.target);
    if (!a || !b) continue;
    springs.push({ a, b, w: e.weight });
  }

  return {
    nodes,
    regionCentres,
    width,
    height,
    iterations: 0,
    target,
    settled: target === 0,
    springs,
    order: [...nodes.values()],
  };
}

/**
 * Run up to `steps` iterations of the simulation, mutating `layout` in place.
 *
 * Chunking is safe: cooling is derived from the absolute iteration counter, so
 * advancing 220 times in one call and 20 times over eleven frames produce the
 * same final positions.
 *
 * Returns true once the layout has settled.
 */
export function advanceLayout(layout: Layout, steps = 1): boolean {
  const { order: list, springs, width, height } = layout;
  const cellKey = (x: number, y: number) => `${Math.floor(x / GRID)},${Math.floor(y / GRID)}`;

  const end = Math.min(layout.target, layout.iterations + steps);

  for (let iter = layout.iterations; iter < end; iter++) {
    // Cooling: big moves early, fine adjustment later.
    const cool = 1 - iter / layout.target;

    // --- Repulsion, via a spatial hash over neighbouring cells. ---
    const grid = new Map<string, Node[]>();
    for (const n of list) {
      const key = cellKey(n.x, n.y);
      const cell = grid.get(key);
      if (cell) cell.push(n);
      else grid.set(key, [n]);
    }

    // --- Repulsion, via a spatial hash over neighbouring cells. ---
    // Unpinned nodes push on each other; pinned nodes also push on unpinned
    // ones so dragging through a cluster shoves nodes aside.
    for (const n of list) {
      if (n.pinned) continue; // Pinned nodes are moved only by the user.
      const gx = Math.floor(n.x / GRID);
      const gy = Math.floor(n.y / GRID);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get(`${gx + dx},${gy + dy}`);
          if (!cell) continue;
          for (const m of cell) {
            if (m === n) continue;
            let ddx = n.x - m.x;
            let ddy = n.y - m.y;
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 > REPULSION_CUTOFF * REPULSION_CUTOFF) continue;
            if (d2 < 0.01) {
              // Coincident nodes: nudge apart deterministically by id order.
              ddx = n.id < m.id ? 0.5 : -0.5;
              ddy = n.id < m.id ? -0.5 : 0.5;
              d2 = 0.5;
            }
            const d = Math.sqrt(d2);
            // Include radii so large nodes claim proportionate space.
            const force = (REPULSION * (1 + (n.r + m.r) / 20)) / d2;
            // Base repulsion coefficient so unpinned nodes push each other
            // apart vigorously. Higher during drag to shove nodes aside.
            n.vx += (ddx / d) * force * 0.015;
            n.vy += (ddy / d) * force * 0.015;
            if (m.pinned) {
              n.vx += (ddx / d) * force * 0.040;
              n.vy += (ddy / d) * force * 0.040;
            }
          }
        }
      }
    }

    // --- Springs along real relations, skipping pinned nodes. ---
    for (const { a, b, w } of springs) {
      if (a.pinned && b.pinned) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const rest = 80 + (1 - w) * 100;
      const f = (d - rest) * SPRING * w;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    }

    // --- Region anchoring and a weak global centring. ---
    for (const n of list) {
      if (n.pinned) {
        // Pinned nodes still experience damping so any velocity accumulated
        // from being pushed by others decays to zero.
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        if (Math.abs(n.vx) < 0.01 && Math.abs(n.vy) < 0.01) {
          n.vx = 0;
          n.vy = 0;
        }
        continue;
      }
      n.vx += (n.ax - n.x) * REGION_PULL;
      n.vy += (n.ay - n.y) * REGION_PULL;
      n.vx += (width / 2 - n.x) * CENTER_PULL;
      n.vy += (height / 2 - n.y) * CENTER_PULL;

      n.vx *= DAMPING;
      n.vy *= DAMPING;

      const maxStep = 14 * cool + 1;
      const step = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (step > maxStep) {
        n.vx = (n.vx / step) * maxStep;
        n.vy = (n.vy / step) * maxStep;
      }
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  layout.iterations = end;
  layout.settled = end >= layout.target;
  return layout.settled;
}

/**
 * Seed and fully settle a layout in one call.
 *
 * Convenient for tests and offline use, but it blocks for as long as the
 * simulation takes — interactive callers should use `createLayout` plus
 * `advanceLayout` so the window stays responsive.
 */
export function computeLayout(
  papers: Paper[],
  edges: Edge[],
  regions: Region[],
  opts: LayoutOptions = {},
): Layout {
  const layout = createLayout(papers, edges, regions, opts);
  advanceLayout(layout, layout.target);
  return layout;
}

/** Bounding box of the laid-out nodes, for fit-to-view. */
export function layoutBounds(layout: Layout): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of layout.nodes.values()) {
    minX = Math.min(minX, n.x - n.r);
    minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r);
    maxY = Math.max(maxY, n.y + n.r);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: layout.width, maxY: layout.height };
  return { minX, minY, maxX, maxY };
}

/**
 * Update region territory centres to track the visual centroid of their
 * member nodes.  Only the drawn circle moves — node anchors (`ax`, `ay`)
 * stay untouched so the region-pull force does not drag anyone into a clump.
 *
 * Call after physics runs so the big washes follow the papers they contain.
 */
export function recomputeRegionCentres(
  nodes: Map<PaperId, Node>,
  regions: Region[],
  regionCentres: Map<string, { x: number; y: number; r: number }>,
): void {
  for (const region of regions) {
    const members = region.members.filter((id) => nodes.has(id));
    if (members.length < 2) continue;

    let cx = 0;
    let cy = 0;
    for (const id of members) {
      const n = nodes.get(id)!;
      cx += n.x;
      cy += n.y;
    }
    cx /= members.length;
    cy /= members.length;

    const existing = regionCentres.get(region.id);
    if (!existing) continue;

    // Smooth interpolation so the territory visibly flows after its papers.
    existing.x += (cx - existing.x) * 0.12;
    existing.y += (cy - existing.y) * 0.12;
  }
}
