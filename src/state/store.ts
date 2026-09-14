import { create } from "zustand";

import { reconcile } from "../game/reconcile";
import type {
  Edge,
  EdgeKind,
  Paper,
  PaperId,
  PaperProgress,
  ReadState,
  Region,
  SaveState,
  WorldView,
} from "../game/types";
import { buildWorld, emptySave } from "../game/world";
import {
  copySlot,
  deleteSlot as deleteStorageSlot,
  exportNotesAsMarkdown,
  flushSave,
  getActiveSlot,
  listSlots,
  loadSave,
  scheduleSave,
  startAutoSave,
  writeSaveNow,
  setActiveSlot,
} from "./storage";

/**
 * Application store.
 *
 * Two kinds of state live here and they are deliberately kept apart:
 *
 *   - `save` is durable. Papers, read state, notes, renames. Persisted.
 *   - everything else is ephemeral session state: what is selected, which
 *     filters are on, whether a fetch is in flight. Never persisted, because
 *     restoring someone into a stale filter is a worse first impression than
 *     restoring them to a clean map.
 *
 * `world` is derived from `save` via `buildWorld` and cached. It is recomputed
 * only when `save` actually changes, since deriving edges over a large corpus
 * is the most expensive thing the app does and React may render many times per
 * save.
 */

/** Which relation kinds to draw. Users turn off the noisy ones. */
export type EdgeFilter = Record<EdgeKind, boolean>;

export const DEFAULT_EDGE_FILTER: EdgeFilter = {
  cites: true,
  coauthor: true,
  keyword: true,
  // Same-venue links are numerous and weak; off by default to keep the map readable.
  venue: false,
  manual: true,
};

export type Panel = "leads" | "expeditions" | "regions" | "paper" | null;

interface Ephemeral {
  selectedId: PaperId | null;
  hoveredId: PaperId | null;
  panel: Panel;
  edgeFilter: EdgeFilter;
  /** Region id to isolate, or null for the whole map. */
  focusRegion: string | null;
  search: string;
  /** In-flight network work, keyed so several can overlap. */
  busy: Record<string, boolean>;
  /** Transient user-facing message. */
  toast: { kind: "info" | "error"; text: string } | null;
  /** Current save slot name. */
  activeSlot: string;
  /** Available save slot names. */
  slots: string[];
  /** Playback: if set, only show papers lit before this timestamp. */
  playbackTime: string | null;
}

interface Actions {
  /** Replace the whole save (import, reset, load sample). */
  replaceSave(save: SaveState): void;
  addPapers(papers: Paper[]): { added: number; merged: number };
  setReadState(id: PaperId, state: ReadState): void;
  setNote(id: PaperId, note: string): void;
  setRating(id: PaperId, rating: PaperProgress["rating"]): void;
  renameRegion(regionId: string, name: string): void;
  addManualEdge(source: PaperId, target: PaperId): void;
  removeManualEdge(source: PaperId, target: PaperId): void;
  /** Remove specific papers and their progress. */
  removePapers(ids: PaperId[]): void;
  /** Update fields on an existing paper (e.g. abstract, keywords from online fetch). */
  updatePaper(id: PaperId, fields: Partial<Paper>): void;
  /** Mark a paper as dismissed (irrelevant, not shown in leads/quests). */
  dismissPaper(id: PaperId): void;
  /** Undismiss a paper. */
  undismissPaper(id: PaperId): void;
  /** Set playback time for timeline. null = normal view. */
  setPlaybackTime(time: string | null): void;
  /** Switch to a different save slot. */
  switchSlot(slot: string): void;
  /** Create a new save slot by copying the current one. */
  copySlotTo(newSlot: string): void;
  /** Delete a save slot (not default). */
  deleteSlot(slot: string): void;
  /** Refresh list of available slots. */
  refreshSlots(): void;

  select(id: PaperId | null): void;
  hover(id: PaperId | null): void;
  setPanel(panel: Panel): void;
  toggleEdgeKind(kind: EdgeKind): void;
  setFocusRegion(regionId: string | null): void;
  setSearch(q: string): void;
  setBusy(key: string, busy: boolean): void;
  notify(kind: "info" | "error", text: string): void;
  dismissToast(): void;
  reset(): void;
  /** Export notes as Markdown and trigger download. */
  exportNotesMarkdown(): void;
}

export interface Store extends Ephemeral, Actions {
  save: SaveState;
  world: WorldView;
}

/** Blank progress record. Centralised so the shape stays consistent. */
function blankProgress(): PaperProgress {
  return { state: "unread", note: "", firstSeenAt: new Date().toISOString() };
}

/**
 * Commit a change to the save file: bump the timestamp, rebuild the derived
 * world, and queue a debounced write. Every mutating action goes through here
 * so persistence can never be forgotten at a call site.
 */
function commit(save: SaveState): { save: SaveState; world: WorldView } {
  const next: SaveState = { ...save, updatedAt: new Date().toISOString() };
  scheduleSave(next);
  return { save: next, world: buildWorld(next) };
}

const initialSlot = getActiveSlot();
const initialSave = loadSave(initialSlot) ?? emptySave();

export const useStore = create<Store>((set, get) => ({
  save: initialSave,
  world: buildWorld(initialSave),
  activeSlot: initialSlot,
  slots: listSlots(),

  selectedId: null,
  hoveredId: null,
  panel: "leads",
  edgeFilter: { ...DEFAULT_EDGE_FILTER },
  focusRegion: null,
  search: "",
  busy: {},
  toast: null,
  playbackTime: null,

  replaceSave(save) {
    writeSaveNow(save);
    set({ ...commit(save), selectedId: null, focusRegion: null, search: "" });
  },

  /**
   * Merge papers in from an import or an online expansion.
   *
   * Reconciliation runs over the combined corpus rather than matching only on
   * id, so a paper arriving under a different identifier joins the existing
   * node instead of becoming a duplicate.
   */
  addPapers(papers) {
    if (papers.length === 0) return { added: 0, merged: 0 };
    const { save } = get();
    const before = Object.keys(save.papers).length;

    const { papers: reconciled } = reconcile([...Object.values(save.papers), ...papers]);
    const nextPapers: Record<PaperId, Paper> = {};
    for (const p of reconciled) nextPapers[p.id] = p;

    const after = reconciled.length;
    const added = Math.max(0, after - before);
    const merged = papers.length - added;

    set(commit({ ...save, papers: nextPapers }));
    writeSaveNow(get().save);
    return { added, merged };
  },

  setReadState(id, state) {
    const { save } = get();
    const existing = save.progress[id] ?? blankProgress();
    const isLit = state === "read" || state === "mastered";
    set(
      commit({
        ...save,
        progress: {
          ...save.progress,
          [id]: {
            ...existing,
            state,
            // Record when it first lit up, and keep that first moment.
            litAt: isLit ? (existing.litAt ?? new Date().toISOString()) : existing.litAt,
          },
        },
      }),
    );
  },

  setNote(id, note) {
    const { save } = get();
    const existing = save.progress[id] ?? blankProgress();
    set(commit({ ...save, progress: { ...save.progress, [id]: { ...existing, note } } }));
  },

  setRating(id, rating) {
    const { save } = get();
    const existing = save.progress[id] ?? blankProgress();
    set(commit({ ...save, progress: { ...save.progress, [id]: { ...existing, rating } } }));
  },

  renameRegion(regionId, name) {
    const { save } = get();
    const regionNames = { ...save.regionNames };
    const trimmed = name.trim();
    // An empty name means "go back to the derived one", not "name it nothing".
    if (trimmed) regionNames[regionId] = trimmed;
    else delete regionNames[regionId];
    set(commit({ ...save, regionNames }));
  },

  addManualEdge(source, target) {
    if (source === target) return;
    const { save } = get();
    const exists = save.manualEdges.some(
      (e) =>
        (e.source === source && e.target === target) ||
        (e.source === target && e.target === source),
    );
    if (exists) return;
    const edge: Edge = { source, target, kind: "manual", weight: 1 };
    set(commit({ ...save, manualEdges: [...save.manualEdges, edge] }));
  },

  dismissPaper(id) {
    const { save } = get();
    if (save.dismissed.includes(id)) return;
    set(commit({ ...save, dismissed: [...save.dismissed, id] }));
  },
  undismissPaper(id) {
    const { save } = get();
    set(commit({ ...save, dismissed: save.dismissed.filter((d) => d !== id) }));
  },

  setPlaybackTime(time) {
    set({ playbackTime: time });
  },

  switchSlot(slot) {
    const { save } = get();
    // Save current to old slot
    writeSaveNow(save);
    setActiveSlot(slot);
    const loaded = loadSave(slot) ?? emptySave();
    set({ ...commit(loaded), activeSlot: slot, selectedId: null, focusRegion: null, search: "", playbackTime: null });
  },

  copySlotTo(newSlot) {
    const { save, activeSlot } = get();
    writeSaveNow(save);
    copySlot(activeSlot, newSlot);
    get().refreshSlots();
  },

  deleteSlot(slot) {
    deleteStorageSlot(slot);
    if (get().activeSlot === slot) {
      get().switchSlot("default");
    }
    get().refreshSlots();
  },

  refreshSlots() {
    set({ slots: listSlots() });
  },

  exportNotesMarkdown() {
    const { world, save } = get();
    const regionOf = new Map<string, Region>();
    for (const r of world.regions) {
      for (const m of r.members) regionOf.set(m, r);
    }
    const md = exportNotesAsMarkdown(world.papers, save.progress, world.regions, regionOf);
    try {
      const blob = new Blob([md], { type: "text/markdown; charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `yantu-notes-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      get().notify("error", "导出笔记失败。");
    }
  },

  removeManualEdge(source, target) {
    const { save } = get();
    const manualEdges = save.manualEdges.filter(
      (e) =>
        !(
          (e.source === source && e.target === target) ||
          (e.source === target && e.target === source)
        ),
    );
    if (manualEdges.length === save.manualEdges.length) return;
    set(commit({ ...save, manualEdges }));
  },

  removePapers(ids) {
    if (ids.length === 0) return;
    const { save } = get();
    const idSet = new Set(ids);
    const papers = { ...save.papers };
    const progress = { ...save.progress };
    for (const id of ids) {
      delete papers[id];
      delete progress[id];
    }
    // Also clean up manual edges referencing removed papers
    const manualEdges = save.manualEdges.filter(
      (e) => !idSet.has(e.source) && !idSet.has(e.target),
    );
    set(commit({ ...save, papers, progress, manualEdges }));
  },

  updatePaper(id, fields) {
    const { save } = get();
    const existing = save.papers[id];
    if (!existing) return;
    const papers = {
      ...save.papers,
      [id]: { ...existing, ...fields },
    };
    set(commit({ ...save, papers }));
  },

  select(id) {
    set({ selectedId: id, panel: id ? "paper" : "leads" });
  },
  hover(id) {
    set({ hoveredId: id });
  },
  setPanel(panel) {
    set({ panel });
  },
  toggleEdgeKind(kind) {
    const { edgeFilter } = get();
    set({ edgeFilter: { ...edgeFilter, [kind]: !edgeFilter[kind] } });
  },
  setFocusRegion(regionId) {
    set({ focusRegion: regionId });
  },
  setSearch(q) {
    set({ search: q });
  },
  setBusy(key, busy) {
    const next = { ...get().busy };
    if (busy) next[key] = true;
    else delete next[key];
    set({ busy: next });
  },
  notify(kind, text) {
    set({ toast: { kind, text } });
  },
  dismissToast() {
    set({ toast: null });
  },
  reset() {
    const fresh = emptySave();
    set({
      ...commit(fresh),
      selectedId: null,
      panel: "leads",
      focusRegion: null,
      search: "",
      edgeFilter: { ...DEFAULT_EDGE_FILTER },
    });
  },
}));

// Start periodic auto-save so data never gets more than a few seconds stale.
if (typeof window !== "undefined") {
  startAutoSave(initialSave);
}

/** Persist immediately when the window goes away, bypassing the debounce. */
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flushSave(useStore.getState().save);
  });
}

/** Is any network work in flight? Drives the global progress affordance. */
export const selectBusy = (s: Store): boolean => Object.keys(s.busy).length > 0;
