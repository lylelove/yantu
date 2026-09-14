import type { Paper, PaperId, PaperProgress, PaperSource } from "./types";

/**
 * Identity reconciliation.
 *
 * The same paper reaches us under different names. A BibTeX import knows its
 * DOI; an OpenAlex citation list refers to works by OpenAlex id; a hand-entered
 * note may have neither. If we took those identifiers at face value, one work
 * would become several unconnected nodes — and the citation edges between them
 * would silently never form, which quietly breaks the fog: a paper you have
 * already read would fail to illuminate the thing it cites.
 *
 * So before any edge is derived, we collapse papers that share an identifier
 * into a single node with one canonical id, and rewrite every citation to point
 * at canonical ids.
 */

/**
 * Which id to keep when a group offers several. A DOI is a global, permanent
 * identifier, so it wins; a `local:` key is derived from a title and is the
 * weakest, so it loses to anything registered with an external authority.
 */
const ID_PREFIX_RANK: Record<string, number> = {
  "doi:": 0,
  "arxiv:": 1,
  "oa:": 2,
  "local:": 3,
};

/**
 * Which record to trust for the *contents* of a merged paper. The user's own
 * data outranks anything fetched: if they corrected a title, that edit must
 * survive a later online expansion of the same work.
 */
const SOURCE_RANK: Record<PaperSource, number> = {
  manual: 0,
  import: 1,
  seed: 2,
  openalex: 3,
};

const idRank = (id: PaperId): number => {
  for (const [prefix, rank] of Object.entries(ID_PREFIX_RANK)) {
    if (id.startsWith(prefix)) return rank;
  }
  // Unknown prefix: rank below local to prefer any known prefix.
  return ID_PREFIX_RANK["local:"] + 1;
};

/** Every identifier that names this paper. */
const identifiersOf = (p: Paper): PaperId[] => [p.id, ...(p.aliases ?? [])];

/** Union-find over identifier strings. */
class DisjointSet {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    // Path compression, iterative to stay safe on long chains.
    const path: string[] = [x];
    while (root !== path[path.length - 1]) {
      path.push(root);
      root = this.parent.get(root) ?? root;
    }
    for (const node of path) this.parent.set(node, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Attach deterministically so results never depend on input order.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

const cleaner = (a: string | undefined, b: string | undefined): string | undefined => {
  const av = a?.trim();
  const bv = b?.trim();
  if (av && bv) return av.length >= bv.length ? av : bv;
  return av || bv || undefined;
};

/** Merge a group of records describing one work into a single paper. */
function mergeGroup(group: Paper[], canonicalId: PaperId): Paper {
  // Most authoritative record first; it supplies the base metadata.
  const ordered = [...group].sort(
    (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || idRank(a.id) - idRank(b.id),
  );

  const base = ordered[0];
  const merged: Paper = { ...base, id: canonicalId };

  const keywords = new Set<string>(base.keywords);
  const references = new Set<PaperId>(base.references);
  const aliases = new Set<PaperId>();
  const authors = [...base.authors];

  for (const p of ordered) {
    for (const id of identifiersOf(p)) aliases.add(id);
    for (const k of p.keywords) keywords.add(k);
    for (const r of p.references) references.add(r);

    // Fill blanks only — never overwrite the authoritative record.
    if (!merged.title.trim() && p.title.trim()) merged.title = p.title;
    if (!merged.venue.trim() && p.venue.trim()) merged.venue = p.venue;
    if (!merged.year && p.year) merged.year = p.year;
    if (p.abstract.trim().length > merged.abstract.trim().length) merged.abstract = p.abstract;
    // Take the fullest author list wholesale rather than merging names: a
    // partial list is usually truncated, not a different set of people, and
    // unioning them would scramble author order.
    if (p.authors.length > authors.length) {
      authors.length = 0;
      authors.push(...p.authors);
    }
    // Citation counts only come from online sources; keep the highest seen.
    if (p.citedByCount > merged.citedByCount) merged.citedByCount = p.citedByCount;
    merged.doi = cleaner(merged.doi, p.doi);
    merged.url = cleaner(merged.url, p.url);
    merged.fetchedAt = merged.fetchedAt ?? p.fetchedAt;
  }

  aliases.delete(canonicalId);
  merged.authors = authors;
  merged.keywords = [...keywords];
  merged.references = [...references];
  merged.aliases = [...aliases].sort();
  return merged;
}

export interface Reconciled {
  papers: Paper[];
  /** Every known identifier mapped to the canonical id of its paper. */
  aliasIndex: Map<string, PaperId>;
  /** How many records collapsed into an existing paper. */
  mergedCount: number;
}

/**
 * Collapse duplicate records and rewrite citations onto canonical ids.
 *
 * Pure and order-independent: the same set of papers in any order yields the
 * same result, which keeps the derived world stable across imports.
 */
export function reconcile(papers: Paper[]): Reconciled {
  const dsu = new DisjointSet();
  for (const p of papers) {
    const ids = identifiersOf(p);
    for (const id of ids) dsu.union(p.id, id);
  }

  // Group papers by the root of their identifier set.
  const groups = new Map<string, Paper[]>();
  for (const p of papers) {
    const root = dsu.find(p.id);
    const group = groups.get(root);
    if (group) group.push(p);
    else groups.set(root, [p]);
  }

  const aliasIndex = new Map<string, PaperId>();
  const out: Paper[] = [];
  let mergedCount = 0;

  for (const group of groups.values()) {
    // Choose the canonical id from *every* identifier in the group, not just
    // the ones records happen to be keyed by. A work whose DOI is only known
    // as an alias still deserves that DOI as its canonical id: otherwise a
    // later import keyed by that same DOI would outrank the current choice and
    // change the paper's identity, invalidating every reference to it.
    const candidates = new Set<PaperId>();
    for (const p of group) {
      for (const id of identifiersOf(p)) candidates.add(id);
    }
    const canonicalId = [...candidates].sort(
      (a, b) => idRank(a) - idRank(b) || (a < b ? -1 : a > b ? 1 : 0),
    )[0];

    // Always merge, even a lone record: the canonical id may have come from an
    // alias, in which case the record's own id has to move into `aliases`.
    const merged = mergeGroup(group, canonicalId);
    mergedCount += group.length - 1;

    for (const p of group) {
      for (const id of identifiersOf(p)) aliasIndex.set(id, canonicalId);
    }
    out.push(merged);
  }

  // Rewrite citations now that every identifier resolves. References to works
  // we do not hold are left untouched; edge derivation ignores them anyway.
  for (const p of out) {
    if (p.references.length === 0) continue;
    const resolved = new Set<PaperId>();
    for (const ref of p.references) {
      const target = aliasIndex.get(ref) ?? ref;
      // A citation to itself is an artefact of merging two records.
      if (target !== p.id) resolved.add(target);
    }
    p.references = [...resolved];
  }

  // Stable output order keeps downstream derivation deterministic.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { papers: out, aliasIndex, mergedCount };
}

/**
 * Move read progress onto canonical ids.
 *
 * Without this, merging would lose read state: a paper the user had read under
 * its OpenAlex id would come back unread once their DOI-keyed library arrived.
 * When both ids carry progress, the further-along one wins, and notes are
 * concatenated rather than dropped.
 */
export function remapProgress(
  progress: Record<PaperId, PaperProgress>,
  aliasIndex: Map<string, PaperId>,
): Record<PaperId, PaperProgress> {
  const READ_RANK: Record<PaperProgress["state"], number> = {
    unread: 0,
    reading: 1,
    read: 2,
    mastered: 3,
  };

  const out: Record<PaperId, PaperProgress> = {};
  for (const [id, pr] of Object.entries(progress)) {
    const target = aliasIndex.get(id) ?? id;
    const existing = out[target];
    if (!existing) {
      out[target] = pr;
      continue;
    }
    const notes = [existing.note.trim(), pr.note.trim()].filter(Boolean);
    out[target] = {
      state: READ_RANK[pr.state] > READ_RANK[existing.state] ? pr.state : existing.state,
      note: [...new Set(notes)].join("\n\n"),
      rating: existing.rating ?? pr.rating,
      firstSeenAt: [existing.firstSeenAt, pr.firstSeenAt].filter(Boolean).sort()[0],
      litAt: [existing.litAt, pr.litAt].filter(Boolean).sort()[0],
    };
  }
  return out;
}
