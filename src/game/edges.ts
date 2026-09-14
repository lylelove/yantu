import type { Edge, EdgeKind, Paper, PaperId } from "./types";

/**
 * Edge derivation.
 *
 * Every edge carries its `kind` so the UI can always answer "why are these two
 * papers connected?". We emit one edge per (pair, kind) rather than collapsing
 * everything into a single blended score: the user can filter by kind, and a
 * citation link means something categorically different from a shared venue.
 */

/** Relative trust in each relation type, used as the base weight. */
const KIND_WEIGHT: Record<EdgeKind, number> = {
  cites: 1,
  coauthor: 0.6,
  keyword: 0.5,
  venue: 0.25,
  manual: 1,
};

/**
 * A keyword shared by nearly every paper carries no signal, and pairing up a
 * huge bucket is quadratic. Buckets larger than these caps are skipped.
 */
const KEYWORD_BUCKET_CAP = 80;
const AUTHOR_BUCKET_CAP = 60;
const VENUE_BUCKET_CAP = 40;

/** One incidental shared term is noise; require real keyword overlap. */
const KEYWORD_SIM_FLOOR = 0.18;

/** Same venue only means something when the work is contemporaneous. */
const VENUE_YEAR_WINDOW = 3;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Order-independent pair key so A-B and B-A collapse to one entry. */
const pairKey = (a: PaperId, b: PaperId) => (a < b ? `${a}${b}` : `${b}${a}`);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Push every unordered pair from a bucket into `sink`. */
function eachPair(ids: PaperId[], cap: number, sink: (a: PaperId, b: PaperId) => void): void {
  if (ids.length < 2 || ids.length > cap) return;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) sink(ids[i], ids[j]);
  }
}

/**
 * Build the edge set for a corpus.
 *
 * Citation edges are directed (source cites target). Similarity kinds are
 * undirected and emitted once per pair.
 */
export function deriveEdges(papers: Paper[], manualEdges: Edge[] = []): Edge[] {
  const byId = new Map<PaperId, Paper>(papers.map((p) => [p.id, p]));
  const out: Edge[] = [];
  const seen = new Set<string>();

  const push = (e: Edge) => {
    // Directed for `cites`, undirected for everything else.
    const key =
      e.kind === "cites"
        ? `cites${e.source}${e.target}`
        : `${e.kind}${pairKey(e.source, e.target)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  // --- Citations: only to papers we actually hold a record for. ---
  for (const p of papers) {
    for (const ref of p.references) {
      if (ref === p.id || !byId.has(ref)) continue;
      push({ source: p.id, target: ref, kind: "cites", weight: KIND_WEIGHT.cites });
    }
  }

  // --- Index by keyword / author / venue to avoid an O(n^2) sweep. ---
  const kwSets = new Map<PaperId, Set<string>>();
  const byKeyword = new Map<string, PaperId[]>();
  const byVenue = new Map<string, PaperId[]>();
  const byAuthor = new Map<string, PaperId[]>();

  const index = (map: Map<string, PaperId[]>, key: string, id: PaperId) => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };

  for (const p of papers) {
    const kws = new Set(p.keywords.map(norm).filter(Boolean));
    kwSets.set(p.id, kws);
    for (const k of kws) index(byKeyword, k, p.id);

    const venue = norm(p.venue);
    if (venue) index(byVenue, venue, p.id);

    for (const a of p.authors) {
      const key = norm(a);
      if (key) index(byAuthor, key, p.id);
    }
  }

  // --- Keyword similarity. Candidates share at least one term. ---
  // The tuple is kept with the key so paper IDs are never parsed back out of
  // a joined string (IDs may contain arbitrary characters).
  const candidates = new Map<string, [PaperId, PaperId]>();
  for (const ids of byKeyword.values()) {
    eachPair(ids, KEYWORD_BUCKET_CAP, (a, b) => candidates.set(pairKey(a, b), [a, b]));
  }
  for (const [a, b] of candidates.values()) {
    const sim = jaccard(kwSets.get(a)!, kwSets.get(b)!);
    if (sim < KEYWORD_SIM_FLOOR) continue;
    push({ source: a, target: b, kind: "keyword", weight: Math.min(1, sim) });
  }

  // --- Co-authorship: a shared author is a strong, cheap signal. ---
  for (const ids of byAuthor.values()) {
    eachPair(ids, AUTHOR_BUCKET_CAP, (a, b) =>
      push({ source: a, target: b, kind: "coauthor", weight: KIND_WEIGHT.coauthor }),
    );
  }

  // --- Venue: weak, and only when the years are close. ---
  for (const ids of byVenue.values()) {
    eachPair(ids, VENUE_BUCKET_CAP, (a, b) => {
      const pa = byId.get(a)!;
      const pb = byId.get(b)!;
      if (Math.abs(pa.year - pb.year) > VENUE_YEAR_WINDOW) return;
      push({ source: a, target: b, kind: "venue", weight: KIND_WEIGHT.venue });
    });
  }

  // --- User-drawn edges last; they always win on weight. ---
  for (const e of manualEdges) {
    if (byId.has(e.source) && byId.has(e.target)) push({ ...e, kind: "manual" });
  }

  return out;
}

/**
 * Undirected adjacency list, keeping the strongest relation between any two
 * papers. Fog propagation and lead scoring both walk this.
 */
export function buildAdjacency(
  papers: Paper[],
  edges: Edge[],
): Map<PaperId, Map<PaperId, number>> {
  const adj = new Map<PaperId, Map<PaperId, number>>();
  for (const p of papers) adj.set(p.id, new Map());
  for (const e of edges) {
    const a = adj.get(e.source);
    const b = adj.get(e.target);
    if (!a || !b) continue;
    a.set(e.target, Math.max(a.get(e.target) ?? 0, e.weight));
    b.set(e.source, Math.max(b.get(e.source) ?? 0, e.weight));
  }
  return adj;
}
