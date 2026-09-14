import { emitsLight } from "./fog";
import type { Lead, Paper, PaperId, PaperProgress, Region, Visibility } from "./types";

/**
 * Lead scoring — "where should I go next?".
 *
 * This is the module that decides whether Yantu widens your view or just helps
 * you burrow. A naive recommender ranks by similarity to what you have already
 * read, which is exactly the filter bubble a researcher needs to escape. So
 * novelty and bridging are weighted above reachability on purpose: the best
 * lead is one that is *reachable but elsewhere*.
 */

/**
 * Scoring weights. Novelty and bridge together outweigh reachability roughly
 * 3:1 — reachability only breaks ties among genuinely new territory, and stops
 * us proposing papers connected to the map by a single thread.
 */
const W_NOVELTY = 0.45;
const W_BRIDGE = 0.3;
const W_REACHABILITY = 0.25;

/** Reachability saturates: past this much lit weight, more adds nothing. */
const REACH_SATURATION = 2.5;

/** Only rank things the user can actually act on. */
const CANDIDATE_LEVELS: ReadonlySet<Visibility> = new Set<Visibility>(["frontier", "sensed"]);

export interface LeadContext {
  papers: Paper[];
  progress: Record<PaperId, PaperProgress>;
  adj: Map<PaperId, Map<PaperId, number>>;
  visibility: Record<PaperId, Visibility>;
  regions: Region[];
  regionOf: Map<PaperId, Region>;
}

/** Fraction of each region that is already lit, keyed by region id. */
function regionCoverage(
  regions: Region[],
  visibility: Record<PaperId, Visibility>,
): Map<string, number> {
  const cov = new Map<string, number>();
  for (const r of regions) {
    if (r.members.length === 0) {
      cov.set(r.id, 0);
      continue;
    }
    let lit = 0;
    for (const id of r.members) {
      if (emitsLight(visibility[id] ?? "fog")) lit++;
    }
    cov.set(r.id, lit / r.members.length);
  }
  return cov;
}

/**
 * Rank the frontier. Returns leads sorted best-first.
 *
 * `limit` caps the result because this feeds a UI panel — the full ranking of
 * a large frontier is not useful to anyone.
 */
export function scoreLeads(ctx: LeadContext, limit = 12): Lead[] {
  const { papers, progress, adj, visibility, regions, regionOf } = ctx;
  const coverage = regionCoverage(regions, visibility);

  // Which regions has the user actually set foot in? Bridging *out* of these
  // is what earns the bridge bonus.
  const enteredRegions = new Set<string>();
  for (const r of regions) {
    if ((coverage.get(r.id) ?? 0) > 0) enteredRegions.add(r.id);
  }

  const leads: Lead[] = [];

  for (const p of papers) {
    const level = visibility[p.id] ?? "fog";
    if (!CANDIDATE_LEVELS.has(level)) continue;
    // Already engaged with it — not a lead any more.
    const state = progress[p.id]?.state;
    if (state === "read" || state === "mastered") continue;

    const reasons: string[] = [];
    const home = regionOf.get(p.id);

    // --- Novelty: how unexplored is the territory this sits in? ---
    const cov = home ? (coverage.get(home.id) ?? 0) : 0;
    const novelty = 1 - cov;
    if (home && cov === 0) {
      reasons.push(`「${home.name}」你还没有踏入过`);
    } else if (home && cov < 0.25) {
      reasons.push(`「${home.name}」仅探索了 ${Math.round(cov * 100)}%`);
    }

    // --- Reachability + which regions point at it. ---
    const neighbours = adj.get(p.id);
    let litWeight = 0;
    let litNeighbours = 0;
    const neighbourRegions = new Set<string>();

    if (neighbours) {
      for (const [nb, weight] of neighbours) {
        const nbRegion = regionOf.get(nb);
        if (nbRegion) neighbourRegions.add(nbRegion.id);
        if (emitsLight(visibility[nb] ?? "fog")) {
          litWeight += weight;
          litNeighbours++;
        }
      }
    }
    const reachability = Math.min(1, litWeight / REACH_SATURATION);
    if (litNeighbours > 0) {
      reasons.push(`与你已读的 ${litNeighbours} 篇相邻`);
    }

    // --- Bridge: does it tie together regions that are strangers? ---
    // Value the *span* across regions, and add a kicker when it links
    // territory you know to territory you do not.
    let bridge = 0;
    if (neighbourRegions.size > 1) {
      bridge = Math.min(1, (neighbourRegions.size - 1) / 2);
      const known = [...neighbourRegions].filter((id) => enteredRegions.has(id));
      const unknown = [...neighbourRegions].filter((id) => !enteredRegions.has(id));
      if (known.length > 0 && unknown.length > 0) {
        bridge = Math.min(1, bridge + 0.35);
        const a = regions.find((r) => r.id === known[0])?.name;
        const b = regions.find((r) => r.id === unknown[0])?.name;
        if (a && b) reasons.push(`连接「${a}」与「${b}」`);
      }
    }

    // A heavily-cited paper in new territory is a foundational text; say so.
    if (p.citedByCount >= 1000 && cov < 0.5) {
      reasons.push(`该方向的高被引文献（${p.citedByCount}）`);
    }

    const score =
      W_NOVELTY * novelty + W_BRIDGE * bridge + W_REACHABILITY * reachability;

    // A lead nothing points at is a dead end, not a suggestion.
    if (litNeighbours === 0 && level === "sensed") continue;

    leads.push({
      paperId: p.id,
      novelty,
      reachability,
      bridge,
      score,
      reasons: reasons.length > 0 ? reasons : ["尚未探索"],
    });
  }

  // Sort by score, breaking ties on id so the panel does not reshuffle
  // between renders for equally-scored leads.
  leads.sort((a, b) => b.score - a.score || (a.paperId < b.paperId ? -1 : 1));
  return leads.slice(0, limit);
}
