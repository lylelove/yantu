/**
 * Yantu core domain types.
 *
 * The map is a graph of papers. What makes it a *game* is that most of the
 * graph is hidden: you only see what your explored nodes illuminate. Reading a
 * paper lights it up, which in turn reveals its neighbours — so the act of
 * research is the act of pushing back fog.
 */

export type PaperId = string;
export type RegionId = string;

/** Where a record came from. Kept so every node can explain itself. */
export type PaperSource = "seed" | "import" | "openalex" | "manual";

export interface Paper {
  id: PaperId;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  keywords: string[];
  /** Global citation count, used for "how load-bearing is this paper". */
  citedByCount: number;
  /** Outgoing citations, by PaperId. May reference not-yet-fetched papers. */
  references: PaperId[];
  doi?: string;
  url?: string;
  source: PaperSource;
  /** Set when the paper was pulled in from an online expansion. */
  fetchedAt?: string;
  /**
   * Set when we last attempted to enrich metadata (abstract, keywords,
   * citedByCount) from an external source. Once set, a paper with still-empty
   * fields is treated as "already checked, nothing more to get" rather than
   * "perpetually missing".
   */
  metaCheckedAt?: string;
  /**
   * Other identifiers naming this same work (e.g. `oa:W123` for a paper whose
   * canonical id is `doi:10.1/x`).
   *
   * This exists because the same paper arrives under different names depending
   * on the source: a BibTeX import knows its DOI, while OpenAlex citation
   * lists refer to works by OpenAlex id. Without aliases, a cited paper you
   * already own would appear as a second, unconnected node — and the citation
   * edge between them would silently never form.
   */
  aliases?: string[];
}

/**
 * Visibility ladder. This is the heart of the fog mechanic.
 *
 * fog      – unknown. Not drawn at all.
 * sensed   – something is out there. Drawn as an unlabelled silhouette.
 * frontier – identified and reachable. Drawn with title, unread. Actionable.
 * lit      – read. Illuminates its neighbours.
 * beacon   – read *and* annotated. Illuminates one hop further than a lit node.
 */
export type Visibility = "fog" | "sensed" | "frontier" | "lit" | "beacon";

/** What the user has actually done with a paper. Drives Visibility. */
export type ReadState = "unread" | "reading" | "read" | "mastered";

export interface PaperProgress {
  state: ReadState;
  /** Free-text note. A non-empty note is what promotes `read` to `beacon`. */
  note: string;
  rating?: 1 | 2 | 3 | 4 | 5;
  firstSeenAt?: string;
  litAt?: string;
}

/** Why two papers are connected. Every edge must be explainable. */
export type EdgeKind = "cites" | "coauthor" | "keyword" | "venue" | "manual";

export interface Edge {
  source: PaperId;
  target: PaperId;
  kind: EdgeKind;
  /** 0..1 relation strength. Controls layout pull and line weight. */
  weight: number;
}

/**
 * A named territory on the map — a cluster of topically close papers.
 * Regions are what let us say "you have never set foot here".
 */
export interface Region {
  id: RegionId;
  name: string;
  /** Terms that characterise the region, most distinctive first. */
  keywords: string[];
  members: PaperId[];
  /** Stable hue (0..360) so a region keeps its colour across sessions. */
  hue: number;
}

/** Derived per-region exploration state. Recomputed, never stored. */
export interface RegionStatus {
  region: Region;
  total: number;
  lit: number;
  /** 0..1 */
  coverage: number;
  /** No lit member yet — a genuine blind spot. */
  untouched: boolean;
  /** Visible (some member is at least sensed) but still untouched. */
  beckoning: boolean;
}

/**
 * A scored suggestion for where to go next. The scoring deliberately favours
 * unfamiliar territory over deepening an already-lit cluster.
 */
export interface Lead {
  paperId: PaperId;
  /** 0..1 – how far outside your explored mass this sits. */
  novelty: number;
  /** 0..1 – how strongly the known map already points at it. */
  reachability: number;
  /** 0..1 – does it join two regions that are currently strangers? */
  bridge: number;
  /** Weighted total used for ranking. */
  score: number;
  /** Human-readable justification, e.g. "connects 因果推断 and 表示学习". */
  reasons: string[];
}

export type QuestKind =
  | "enter-region"
  | "trace-citations"
  | "read-foundational"
  | "cross-bridge"
  | "close-gap";

export interface Quest {
  id: string;
  kind: QuestKind;
  title: string;
  detail: string;
  /** Papers or regions that satisfy it. */
  targets: string[];
  progress: number;
  goal: number;
  done: boolean;
}

/** Everything the user has accumulated. This is the save file. */
export interface SaveState {
  version: 1;
  papers: Record<PaperId, Paper>;
  progress: Record<PaperId, PaperProgress>;
  /** Manually added edges, kept apart from derived ones. */
  manualEdges: Edge[];
  /** Region name overrides, so users can rename a territory. */
  regionNames: Record<RegionId, string>;
  /** Papers the user has explicitly dismissed as irrelevant. */
  dismissed: PaperId[];
  createdAt: string;
  updatedAt: string;
}

/** The fully derived view of the world that the UI renders. */
export interface WorldView {
  papers: Paper[];
  edges: Edge[];
  regions: Region[];
  /**
   * Read progress keyed by *canonical* paper id.
   *
   * The UI must read this rather than `SaveState.progress`: when duplicate
   * records merge, a paper's canonical id can change, and the raw save may
   * still key its progress under the old identifier. Reading the save directly
   * is how you end up with a paper the map draws as lit while the detail panel
   * insists it is unread.
   */
  progress: Record<PaperId, PaperProgress>;
  visibility: Record<PaperId, Visibility>;
  regionStatus: RegionStatus[];
  leads: Lead[];
  quests: Quest[];
  stats: WorldStats;
}

export interface WorldStats {
  known: number;
  lit: number;
  beacons: number;
  frontier: number;
  sensed: number;
  /** Regions with at least one lit paper. */
  regionsEntered: number;
  regionsKnown: number;
  /** 0..1 across everything currently known. */
  coverage: number;
  /** How many hops the lit set currently projects. */
  visionRadius: number;
}
