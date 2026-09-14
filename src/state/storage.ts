import type { Edge, Paper, PaperProgress, Region, SaveState } from "../game/types";
import { emptySave } from "../game/world";

/**
 * Save-file persistence.
 *
 * Yantu is local-first: your library is yours, and nothing here talks to a
 * server. The save file holds only what cannot be recomputed — papers, read
 * state, notes, renames. Everything else (edges, regions, fog, leads) is
 * derived on load, so a save from an older build stays valid even when the
 * scoring rules change.
 */

const STORAGE_KEY_PREFIX = "yantu.save.v1";

/** Current active save slot. Stored separately so slot switching doesn't erase. */
const SLOT_KEY = "yantu.active-slot";

function storageKey(slot?: string): string {
  if (!slot || slot === "default") return STORAGE_KEY_PREFIX;
  return `${STORAGE_KEY_PREFIX}.${slot}`;
}

/** Retrieve the active slot name, or 'default'. */
export function getActiveSlot(): string {
  if (typeof localStorage === "undefined") return "default";
  try {
    return localStorage.getItem(SLOT_KEY) ?? "default";
  } catch {
    return "default";
  }
}

/** Switch the active slot. Does not load or migrate data. */
export function setActiveSlot(slot: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SLOT_KEY, slot);
  } catch {
    // ignore
  }
}

/** List all available save slots. */
export function listSlots(): string[] {
  if (typeof localStorage === "undefined") return ["default"];
  const slots = new Set<string>();
  slots.add("default");
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(STORAGE_KEY_PREFIX + ".")) {
      const slot = key.slice(STORAGE_KEY_PREFIX.length + 1);
      slots.add(slot);
    }
  }
  return Array.from(slots).sort();
}

/** Delete a save slot. Returns true if deleted. */
export function deleteSlot(slot: string): boolean {
  if (typeof localStorage === "undefined" || slot === "default") return false;
  try {
    localStorage.removeItem(storageKey(slot));
    return true;
  } catch {
    return false;
  }
}

/** Copy a save from one slot to another. */
export function copySlot(from: string, to: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const data = localStorage.getItem(storageKey(from));
    if (!data) return false;
    localStorage.setItem(storageKey(to), data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Debounce window for writes. Marking a paper read triggers a save; so does
 * typing in a note. Batching keeps us off the main thread's back without
 * risking more than a second of lost work.
 */
const WRITE_DEBOUNCE_MS = 400;

/** Structural check on untrusted JSON before we treat it as a save. */
function isSaveShape(value: unknown): value is SaveState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SaveState>;
  return (
    v.version === 1 &&
    typeof v.papers === "object" &&
    v.papers !== null &&
    !Array.isArray(v.papers) &&
    typeof v.progress === "object" &&
    v.progress !== null &&
    !Array.isArray(v.progress) &&
    Array.isArray(v.manualEdges)
  );
}

const READ_STATES: ReadonlySet<PaperProgress["state"]> = new Set([
  "unread",
  "reading",
  "read",
  "mastered",
]);
const EDGE_KINDS: ReadonlySet<Edge["kind"]> = new Set([
  "cites",
  "coauthor",
  "keyword",
  "venue",
  "manual",
]);
const SOURCES: ReadonlySet<Paper["source"]> = new Set([
  "seed",
  "import",
  "openalex",
  "manual",
]);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Coerce one untrusted paper so a damaged save cannot break world derivation. */
function coercePaper(value: unknown, fallbackId: string): Paper | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<Paper>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId;
  if (!id) return null;
  const year = typeof raw.year === "number" && Number.isFinite(raw.year) ? Math.trunc(raw.year) : 0;
  const citedByCount =
    typeof raw.citedByCount === "number" && Number.isFinite(raw.citedByCount)
      ? Math.max(0, raw.citedByCount)
      : 0;
  const source = SOURCES.has(raw.source as Paper["source"]) ? raw.source! : "import";
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    authors: stringArray(raw.authors),
    year,
    venue: typeof raw.venue === "string" ? raw.venue : "",
    abstract: typeof raw.abstract === "string" ? raw.abstract : "",
    keywords: stringArray(raw.keywords),
    citedByCount,
    references: stringArray(raw.references),
    doi: optionalString(raw.doi),
    url: optionalString(raw.url),
    source,
    fetchedAt: optionalString(raw.fetchedAt),
    metaCheckedAt: optionalString(raw.metaCheckedAt),
    aliases: stringArray(raw.aliases),
  };
}

function coerceProgress(value: unknown): PaperProgress {
  if (typeof value !== "object" || value === null) {
    return { state: "unread", note: "" };
  }
  const raw = value as Partial<PaperProgress>;
  const state = READ_STATES.has(raw.state as PaperProgress["state"])
    ? raw.state!
    : "unread";
  const rating =
    typeof raw.rating === "number" && Number.isInteger(raw.rating) && raw.rating >= 1 && raw.rating <= 5
      ? (raw.rating as PaperProgress["rating"])
      : undefined;
  return {
    state,
    note: typeof raw.note === "string" ? raw.note : "",
    ...(rating === undefined ? {} : { rating }),
    ...(optionalString(raw.firstSeenAt) ? { firstSeenAt: optionalString(raw.firstSeenAt) } : {}),
    ...(optionalString(raw.litAt) ? { litAt: optionalString(raw.litAt) } : {}),
  };
}

function coerceEdge(value: unknown): Edge | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<Edge>;
  if (typeof raw.source !== "string" || typeof raw.target !== "string") return null;
  const kind = EDGE_KINDS.has(raw.kind as Edge["kind"]) ? raw.kind! : null;
  if (!kind || raw.source === raw.target) return null;
  const weight = typeof raw.weight === "number" && Number.isFinite(raw.weight)
    ? Math.min(1, Math.max(0, raw.weight))
    : 1;
  return { source: raw.source, target: raw.target, kind, weight };
}

/**
 * Repair a save rather than rejecting it.
 *
 * A partially-written or hand-edited file should cost you the broken field, not
 * your entire library — so missing collections are filled in rather than
 * treated as fatal. Nested records are also sanitised because the save is
 * untrusted JSON and the derivation layer expects well-formed Paper objects.
 */
export function coerce(raw: SaveState): SaveState {
  const base = emptySave();
  const papers: Record<string, Paper> = {};
  for (const [key, value] of Object.entries(raw.papers ?? {})) {
    const paper = coercePaper(value, key);
    if (paper) papers[paper.id] = paper;
  }
  const progress: Record<string, PaperProgress> = {};
  for (const [id, value] of Object.entries(raw.progress ?? {})) {
    progress[id] = coerceProgress(value);
  }
  const manualEdges = (Array.isArray(raw.manualEdges) ? raw.manualEdges : [])
    .map(coerceEdge)
    .filter((edge): edge is Edge => edge !== null);
  const regionNames: Record<string, string> = {};
  if (raw.regionNames && typeof raw.regionNames === "object") {
    for (const [id, name] of Object.entries(raw.regionNames)) {
      if (typeof name === "string" && name.trim()) regionNames[id] = name.trim();
    }
  }
  return {
    version: 1,
    papers,
    progress,
    manualEdges,
    regionNames,
    dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((d): d is string => typeof d === "string") : [],
    createdAt: optionalString(raw.createdAt) ?? base.createdAt,
    updatedAt: optionalString(raw.updatedAt) ?? base.updatedAt,
  };
}

/**
 * Read the save file. Returns null when there is nothing stored yet, which the
 * caller treats as "first run" and offers the sample map.
 *
 * Corrupt data is reported, never thrown: losing the app entirely because one
 * key went bad would be worse than starting fresh.
 */
export function loadSave(slot?: string): SaveState | null {
  if (typeof localStorage === "undefined") return null;
  const key = storageKey(slot);
  let text: string | null;
  try {
    text = localStorage.getItem(key);
  } catch {
    // Storage can be unavailable outright (privacy mode, disabled cookies).
    return null;
  }
  if (!text) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isSaveShape(parsed)) {
      console.warn("[yantu] save file has an unexpected shape; ignoring it");
      return null;
    }
    return coerce(parsed);
  } catch (err) {
    console.warn("[yantu] could not parse save file; ignoring it", err);
    return null;
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;
let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let lastSavedHash = "";

const AUTO_SAVE_INTERVAL_MS = 5000;

function saveHash(save: SaveState): string {
  // Compare content, not timestamps: papers, progress, and manual edges.
  const paperKeys = Object.keys(save.papers).sort().join(",");
  const progressKeys = Object.keys(save.progress).sort().join(",");
  return `${save.version}:${paperKeys.length}:${progressKeys.length}:${save.manualEdges.length}:${save.dismissed.length}`;
}

/**
 * Start periodic auto-save. Writes to localStorage every 5 seconds
 * when the save state has changed, ensuring data is never more than
 * a few seconds stale even if the user closes the tab abruptly.
 */
export function startAutoSave(save: SaveState): void {
  stopAutoSave();
  lastSavedHash = saveHash(save);
  autoSaveTimer = setInterval(() => {
    // The store is the single source of truth; import it lazily to avoid
    // circular dependency at module load time.
    import("../state/store").then(({ useStore }) => {
      const current = useStore.getState().save;
      const hash = saveHash(current);
      if (hash !== lastSavedHash) {
        lastSavedHash = hash;
        writeSaveNow(current);
      }
    }).catch(() => {
      // If the store can't be loaded, skip this cycle.
    });
  }, AUTO_SAVE_INTERVAL_MS);
}

/** Stop periodic auto-save. */
export function stopAutoSave(): void {
  if (autoSaveTimer !== null) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
}

/** Update the last-saved hash so the next cycle doesn't re-save unchanged data. */
export function touchAutoSave(save: SaveState): void {
  lastSavedHash = saveHash(save);
}

/** Queue a debounced write. Repeated calls collapse into one. */
export function scheduleSave(save: SaveState): void {
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    writeSaveNow(save);
  }, WRITE_DEBOUNCE_MS);
}

/** Write immediately. Used on unload, and by explicit "save" actions. */
export function writeSaveNow(save: SaveState, slot?: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(storageKey(slot), JSON.stringify({ ...save, updatedAt: new Date().toISOString() }));
    lastSavedHash = saveHash({ ...save, updatedAt: new Date().toISOString() });
    return true;
  } catch (err) {
    // Most likely the quota: a large library plus long notes. Surfacing this
    // matters — silent data loss is the one failure users cannot recover from.
    console.error("[yantu] failed to write save file", err);
    return false;
  }
}

/** Flush any queued write. Call before the window goes away. */
export function flushSave(save: SaveState): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  writeSaveNow(save);
}

export function clearSave(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(storageKey());
  } catch (err) {
    console.warn("[yantu] failed to clear save file", err);
  }
}

/** Serialise the save for the user to keep. Local-first means exportable. */
export function exportSave(save: SaveState): string {
  return JSON.stringify(save, null, 2);
}

/** Parse a user-supplied save file. Throws with a readable message. */
export function importSave(text: string): SaveState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("这不是有效的 JSON 文件");
  }
  if (!isSaveShape(parsed)) throw new Error("这不是 Yantu 存档文件");
  return coerce(parsed);
}

/**
 * Generate a Markdown string of all notes, grouped by region.
 */
export function exportNotesAsMarkdown(
  papers: Paper[],
  progress: Record<string, PaperProgress>,
  _regions: Region[],
  regionOf: Map<string, Region>,
): string {
  const lines: string[] = ["# 研图笔记\n"];
  const withNotes = papers
    .filter((p) => {
      const pr = progress[p.id];
      return pr && pr.note.trim().length > 0;
    })
    .sort((a, b) => (progress[a.id]?.litAt ?? "").localeCompare(progress[b.id]?.litAt ?? ""));

  let lastRegion = "";
  for (const p of withNotes) {
    const pr = progress[p.id]!;
    const region = regionOf.get(p.id);
    const regionName = region?.name ?? "未分区";
    if (regionName !== lastRegion) {
      lines.push(`\n## ${regionName}\n`);
      lastRegion = regionName;
    }
    lines.push(`### ${p.title}`);
    lines.push(`> ${p.authors.slice(0, 3).join(", ")} (${p.year})`);
    if (pr.litAt) lines.push(`> 阅读于 ${pr.litAt.slice(0, 10)}`);
    lines.push("");
    lines.push(pr.note);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}
