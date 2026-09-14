import type { Paper, PaperId, PaperProgress, Visibility } from "./types";

/**
 * Fog of war.
 *
 * The rule that makes Yantu a game rather than a graph viewer: you do not see
 * the whole corpus. You see what your own reading illuminates.
 *
 *   - Papers in your library are yours, so they are always at least `frontier`.
 *     Your library is the known world.
 *   - Papers pulled from online sources start in `fog`. They are the unknown,
 *     and only become visible when something you have read points at them.
 *   - Reading a paper makes it `lit`, which reveals its neighbours.
 *   - Annotating a paper you have read makes it a `beacon`, which reaches one
 *     hop further than a plain `lit` node. Thinking about what you read
 *     literally widens your field of view.
 */

/**
 * Sources you own outright. These are never hidden: the user imported them, so
 * pretending they are undiscovered would be a lie about their own library.
 */
const OWNED_SOURCES: ReadonlySet<Paper["source"]> = new Set(["seed", "import", "manual"]);

/**
 * Light does not travel down every edge. A shared venue (weight 0.25) is too
 * weak a signal to claim it reveals anything; citations and real keyword
 * overlap are not.
 */
export const PROPAGATION_FLOOR = 0.3;

/** How far a plain `lit` node projects. */
const LIT_FRONTIER = 1;
const LIT_SENSED = 2;

/** A `beacon` reaches exactly one hop further at every tier. */
const BEACON_FRONTIER = 2;
const BEACON_SENSED = 3;

export interface FogResult {
  visibility: Record<PaperId, Visibility>;
  /** Max hop count at which anything is currently revealed. */
  visionRadius: number;
}

/** Has the user actually read this? Drives whether a node emits light. */
function isLit(progress: PaperProgress | undefined): boolean {
  return progress?.state === "read" || progress?.state === "mastered";
}

/**
 * A read paper with a note (or explicitly mastered) becomes a beacon. The note
 * is the point: an annotation is evidence you engaged, and engagement is what
 * earns the wider view.
 */
function isBeacon(progress: PaperProgress | undefined): boolean {
  if (!progress) return false;
  if (progress.state === "mastered") return true;
  return progress.state === "read" && progress.note.trim().length > 0;
}

/**
 * Breadth-first hop distance from a set of sources, travelling only along edges
 * strong enough to carry light.
 */
function bfsFrom(
  sources: PaperId[],
  adj: Map<PaperId, Map<PaperId, number>>,
  maxDepth: number,
): Map<PaperId, number> {
  const dist = new Map<PaperId, number>();
  let layer = sources.filter((id) => adj.has(id));
  for (const id of layer) dist.set(id, 0);

  for (let depth = 1; depth <= maxDepth && layer.length > 0; depth++) {
    const next: PaperId[] = [];
    for (const id of layer) {
      const neighbours = adj.get(id);
      if (!neighbours) continue;
      for (const [nb, weight] of neighbours) {
        if (weight < PROPAGATION_FLOOR) continue;
        if (dist.has(nb)) continue;
        dist.set(nb, depth);
        next.push(nb);
      }
    }
    layer = next;
  }
  return dist;
}

/**
 * Resolve the visibility of every known paper.
 *
 * Note this returns a level for papers in `fog` too. The renderer is
 * responsible for not drawing them; keeping them in the map means callers can
 * ask "how much is still hidden?" without a second pass.
 */
export function computeFog(
  papers: Paper[],
  progress: Record<PaperId, PaperProgress>,
  adj: Map<PaperId, Map<PaperId, number>>,
): FogResult {
  const litSources: PaperId[] = [];
  const beaconSources: PaperId[] = [];

  for (const p of papers) {
    const pr = progress[p.id];
    if (isBeacon(pr)) beaconSources.push(p.id);
    if (isLit(pr)) litSources.push(p.id);
  }

  const distLit = bfsFrom(litSources, adj, LIT_SENSED);
  const distBeacon = bfsFrom(beaconSources, adj, BEACON_SENSED);

  const visibility: Record<PaperId, Visibility> = {};
  let visionRadius = 0;

  for (const p of papers) {
    const pr = progress[p.id];

    // Read state wins outright — you cannot un-see what you have read.
    if (isBeacon(pr)) {
      visibility[p.id] = "beacon";
      continue;
    }
    if (isLit(pr)) {
      visibility[p.id] = "lit";
      continue;
    }

    // Anything you own, or are partway through, is identified.
    if (OWNED_SOURCES.has(p.source) || pr?.state === "reading") {
      visibility[p.id] = "frontier";
      continue;
    }

    const dl = distLit.get(p.id);
    const db = distBeacon.get(p.id);

    let level: Visibility = "fog";
    let reachedAt = 0;

    if ((dl !== undefined && dl <= LIT_FRONTIER) || (db !== undefined && db <= BEACON_FRONTIER)) {
      level = "frontier";
      reachedAt = Math.min(dl ?? Infinity, db ?? Infinity);
    } else if (
      (dl !== undefined && dl <= LIT_SENSED) ||
      (db !== undefined && db <= BEACON_SENSED)
    ) {
      level = "sensed";
      reachedAt = Math.min(dl ?? Infinity, db ?? Infinity);
    }

    visibility[p.id] = level;
    if (level !== "fog") visionRadius = Math.max(visionRadius, reachedAt);
  }

  return { visibility, visionRadius };
}

/** Visibility levels the user can actually interact with. */
export function isVisible(v: Visibility): boolean {
  return v !== "fog";
}

/** Does this node emit light? Used for stats and for lead scoring. */
export function emitsLight(v: Visibility): boolean {
  return v === "lit" || v === "beacon";
}
