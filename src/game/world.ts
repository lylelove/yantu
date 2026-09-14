import { buildAdjacency, deriveEdges } from "./edges";
import { computeFog, emitsLight } from "./fog";
import { scoreLeads } from "./leads";
import { deriveQuests } from "./quests";
import { reconcile, remapProgress } from "./reconcile";
import { deriveRegions, regionIndex } from "./regions";
import type {
  Paper,
  PaperId,
  PaperProgress,
  Region,
  RegionStatus,
  SaveState,
  Visibility,
  WorldStats,
  WorldView,
} from "./types";

/**
 * World composition.
 *
 * The single place where a `SaveState` (what we persist: papers, read progress,
 * notes) becomes a `WorldView` (what the UI draws: edges, regions, fog, leads,
 * expeditions). Everything downstream of the save file is *derived* — nothing
 * here is stored.
 *
 * That is a deliberate architectural choice. Derived state cannot drift out of
 * sync with the save file, cannot be corrupted by a partial write, and means
 * changing a scoring rule takes effect on existing saves with no migration.
 */

/** Per-region exploration state, including the blind-spot flags. */
function computeRegionStatus(
  regions: Region[],
  visibility: Record<PaperId, Visibility>,
): RegionStatus[] {
  return regions.map((region) => {
    let lit = 0;
    let anyVisible = false;
    for (const id of region.members) {
      const v = visibility[id] ?? "fog";
      if (emitsLight(v)) lit++;
      if (v !== "fog") anyVisible = true;
    }
    const total = region.members.length;
    const coverage = total === 0 ? 0 : lit / total;
    const untouched = lit === 0;
    return {
      region,
      total,
      lit,
      coverage,
      untouched,
      // Visible on the map, but you have never read anything here. This is the
      // flag the "step into somewhere new" prompts are built on.
      beckoning: untouched && anyVisible,
    };
  });
}

function computeStats(
  papers: Paper[],
  visibility: Record<PaperId, Visibility>,
  regionStatus: RegionStatus[],
  visionRadius: number,
): WorldStats {
  let lit = 0;
  let beacons = 0;
  let frontier = 0;
  let sensed = 0;
  let known = 0;

  for (const p of papers) {
    const v = visibility[p.id] ?? "fog";
    if (v === "fog") continue;
    known++;
    if (v === "beacon") {
      beacons++;
      lit++;
    } else if (v === "lit") lit++;
    else if (v === "frontier") frontier++;
    else if (v === "sensed") sensed++;
  }

  // Coverage is measured against what you can see, not the whole corpus:
  // pulling in 500 online papers should not make your progress bar collapse.
  const regionsKnown = regionStatus.filter((r) =>
    r.region.members.some((id) => (visibility[id] ?? "fog") !== "fog"),
  ).length;

  return {
    known,
    lit,
    beacons,
    frontier,
    sensed,
    regionsEntered: regionStatus.filter((r) => r.lit > 0).length,
    regionsKnown,
    coverage: known === 0 ? 0 : lit / known,
    visionRadius,
  };
}

/**
 * Build the full derived view. This is pure — same save in, same view out.
 *
 * Cost is dominated by edge derivation; callers should memoise on the save
 * state rather than calling this per render.
 */
export function buildWorld(save: SaveState): WorldView {
  // Collapse duplicate records first. Everything below depends on identity
  // being settled: an unreconciled corpus derives citation edges that point at
  // ids nobody holds, which would leave papers dark that should be lit.
  const { papers, aliasIndex } = reconcile(Object.values(save.papers));
  const progress = remapProgress(save.progress, aliasIndex);

  // Filter out dismissed papers (user marked as irrelevant).
  // Remap dismissed ids through the alias index so a paper dismissed before
  // a merge is still properly filtered.
  const dismissedSet = new Set(
    save.dismissed.map((d) => aliasIndex.get(d) ?? d),
  );
  const activePapers = dismissedSet.size > 0
    ? papers.filter((p) => !dismissedSet.has(p.id))
    : papers;
  const activeProgress: Record<PaperId, PaperProgress> = {};
  for (const pid of Object.keys(progress)) {
    if (!dismissedSet.has(pid)) activeProgress[pid] = progress[pid];
  }

  // Manual edges are user assertions, so they must survive a merge too.
  const manualEdges = save.manualEdges.map((e) => ({
    ...e,
    source: aliasIndex.get(e.source) ?? e.source,
    target: aliasIndex.get(e.target) ?? e.target,
  }));

  const edges = deriveEdges(activePapers, manualEdges);
  const adj = buildAdjacency(activePapers, edges);

  const rawRegions = deriveRegions(activePapers);
  // Apply user renames without disturbing membership or hue.
  const regions = rawRegions.map((r) =>
    save.regionNames[r.id] ? { ...r, name: save.regionNames[r.id] } : r,
  );
  const regionOf = regionIndex(regions);

  const { visibility, visionRadius } = computeFog(activePapers, activeProgress, adj);

  const regionStatus = computeRegionStatus(regions, visibility);

  const leads = scoreLeads({
    papers: activePapers,
    progress: activeProgress,
    adj,
    visibility,
    regions,
    regionOf,
  });

  const quests = deriveQuests({
    papers: new Map(activePapers.map((p) => [p.id, p])),
    progress: activeProgress,
    visibility,
    regionStatus,
    regions,
    regionOf,
    leads,
    adj,
  });

  const stats = computeStats(activePapers, visibility, regionStatus, visionRadius);

  return {
    papers: activePapers,
    edges,
    regions,
    // The remapped progress, not `save.progress` — see WorldView.progress.
    progress: activeProgress,
    visibility,
    regionStatus,
    leads,
    quests,
    stats,
  };
}

/** An empty save, used for first run and for "start over". */
export function emptySave(): SaveState {
  const now = new Date().toISOString();
  return {
    version: 1,
    papers: {},
    progress: {},
    manualEdges: [],
    regionNames: {},
    dismissed: [],
    createdAt: now,
    updatedAt: now,
  };
}
