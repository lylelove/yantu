import { emitsLight } from "./fog";
import type {
  Lead,
  Paper,
  PaperId,
  PaperProgress,
  Quest,
  Region,
  RegionStatus,
  Visibility,
} from "./types";

/**
 * Expeditions — soft objectives derived from the current map.
 *
 * These are deliberately *not* a separate progression system with its own saved
 * state. They are a reading of the map: "this region is visible but you have
 * never entered it", "this paper joins two territories". Because they are
 * derived, they cannot go stale, cannot be gamed by grinding, and disappear on
 * their own once the underlying situation changes.
 *
 * The fog is the game. Expeditions are signposts in it.
 */

/** Cap so the panel stays a shortlist rather than a backlog. */
const MAX_QUESTS = 5;

/** Below this coverage a region you have entered still counts as thin. */
const THIN_COVERAGE = 0.34;

export interface QuestContext {
  papers: Map<PaperId, Paper>;
  progress: Record<PaperId, PaperProgress>;
  visibility: Record<PaperId, Visibility>;
  regionStatus: RegionStatus[];
  regions: Region[];
  regionOf: Map<PaperId, Region>;
  leads: Lead[];
  adj: Map<PaperId, Map<PaperId, number>>;
}

const titleOf = (papers: Map<PaperId, Paper>, id: PaperId) => papers.get(id)?.title ?? id;

/** Shorten a title for inline use without cutting mid-word where avoidable. */
function brief(title: string, max = 42): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function deriveQuests(ctx: QuestContext): Quest[] {
  const { papers, progress, visibility, regionStatus, regionOf, leads, adj } = ctx;
  const quests: Quest[] = [];

  // --- 1. Step into a region you can see but have never entered. ---
  // Ranked by how much is waiting there, so the suggestion is substantial.
  const beckoning = regionStatus
    .filter((r) => r.beckoning)
    .sort((a, b) => b.total - a.total);

  for (const status of beckoning.slice(0, 2)) {
    const reachable = status.region.members.filter((id) => {
      const v = visibility[id] ?? "fog";
      return v === "frontier" || v === "sensed";
    });
    if (reachable.length === 0) continue;
    quests.push({
      id: `quest:enter:${status.region.id}`,
      kind: "enter-region",
      title: `踏入「${status.region.name}」`,
      detail: `这片区域已在视野中，但你还没有读过其中任何一篇。可见 ${reachable.length} 篇。`,
      targets: reachable,
      progress: 0,
      goal: 1,
      done: false,
    });
  }

  // --- 2. Cross a bridge: read the paper joining two territories. ---
  const bridgeLead = leads.find((l) => l.bridge >= 0.5);
  if (bridgeLead) {
    const home = regionOf.get(bridgeLead.paperId);
    quests.push({
      id: `quest:bridge:${bridgeLead.paperId}`,
      kind: "cross-bridge",
      title: "跨过一座桥",
      detail: `《${brief(titleOf(papers, bridgeLead.paperId))}》${
        home ? `位于「${home.name}」，` : ""
      }同时连接着多片区域，读它能一次打开几个方向。`,
      targets: [bridgeLead.paperId],
      progress: 0,
      goal: 1,
      done: false,
    });
  }

  // --- 3. Read the foundational text of somewhere you have only sampled. ---
  const thin = regionStatus
    .filter((r) => !r.untouched && r.coverage > 0 && r.coverage < THIN_COVERAGE)
    .sort((a, b) => a.coverage - b.coverage);

  for (const status of thin.slice(0, 1)) {
    let best: Paper | undefined;
    for (const id of status.region.members) {
      const v = visibility[id] ?? "fog";
      if (v === "fog" || emitsLight(v)) continue;
      const p = papers.get(id);
      if (!p) continue;
      if (!best || p.citedByCount > best.citedByCount) best = p;
    }
    if (!best) continue;
    quests.push({
      id: `quest:foundational:${best.id}`,
      kind: "read-foundational",
      title: `补上「${status.region.name}」的地基`,
      detail: `《${brief(best.title)}》在这片区域里被引 ${best.citedByCount} 次，是绕不开的一篇。`,
      targets: [best.id],
      progress: 0,
      goal: 1,
      done: false,
    });
  }

  // --- 4. Follow a citation chain backwards to its source. ---
  // Only offered once something is lit, since it needs a starting point.
  const litIds = Object.keys(visibility).filter((id) => emitsLight(visibility[id] ?? "fog"));
  if (litIds.length > 0) {
    let anchor: Paper | undefined;
    let unreadRefs: PaperId[] = [];
    for (const id of litIds) {
      const p = papers.get(id);
      if (!p) continue;
      const refs = p.references.filter((r) => {
        if (!papers.has(r)) return false;
        const st = progress[r]?.state;
        return st !== "read" && st !== "mastered";
      });
      if (refs.length > unreadRefs.length) {
        anchor = p;
        unreadRefs = refs;
      }
    }
    if (anchor && unreadRefs.length >= 2) {
      const goal = Math.min(2, unreadRefs.length);
      quests.push({
        id: `quest:trace:${anchor.id}`,
        kind: "trace-citations",
        title: "沿引用链回溯",
        detail: `《${brief(anchor.title)}》引用了 ${unreadRefs.length} 篇你还没读的文献。回溯 ${goal} 篇，看清它站在谁的肩膀上。`,
        targets: unreadRefs,
        progress: 0,
        goal,
        done: false,
      });
    }
  }

  // --- 5. An annotated paper lights one hop further; nudge toward that. ---
  const readNoNote = Object.entries(progress).filter(
    ([id, pr]) => pr.state === "read" && pr.note.trim() === "" && papers.has(id),
  );
  if (readNoNote.length >= 2 && adj.size > 0) {
    quests.push({
      id: "quest:beacons",
      kind: "close-gap",
      title: "点亮灯塔",
      detail: `有 ${readNoNote.length} 篇已读但没有笔记。写下想法会让它们照得更远一跳。`,
      targets: readNoNote.map(([id]) => id),
      progress: 0,
      goal: Math.min(2, readNoNote.length),
      done: false,
    });
  }

  return quests.slice(0, MAX_QUESTS);
}
