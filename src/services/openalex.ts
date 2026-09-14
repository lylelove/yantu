/**
 * Client for the OpenAlex API (https://docs.openalex.org).
 *
 * OpenAlex works are converted into the game's `Paper` type. Because papers
 * can enter the map from more than one source (a manual DOI import, an
 * OpenAlex search, a citation expansion...), every paper carries a canonical
 * id plus a set of aliases so the app can later realise "these are the same
 * work" even though they were discovered independently.
 *
 * Canonical id rule: `doi:<normalized doi>` when a DOI is known, otherwise
 * `oa:<openalex short id>` (e.g. `oa:W2741809807`).
 */

import type { Paper } from "../game/types";

const OPENALEX_BASE = "https://api.openalex.org";

// OpenAlex's "polite pool" asks clients to identify themselves via a mailto
// param in exchange for faster, more reliable responses. Replace with a real
// contact address before shipping.
const CONTACT = "yantu-app@example.invalid";

const MAX_KEYWORDS = 8;
const MAX_REFERENCES = 200;
const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 200;
const ID_BATCH_SIZE = 50;

const SELECT_FIELDS = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "cited_by_count",
  "authorships",
  "primary_location",
  "abstract_inverted_index",
  "referenced_works",
  "topics",
  "concepts",
].join(",");

// ---- OpenAlex response shapes (deliberately optional/nullable throughout —
// the API omits fields freely, and we treat all of it as untrusted input) ----

/** Anything in the OpenAlex payload that is just a labelled entity. */
export interface OpenAlexNamed {
  display_name?: string | null;
}

export interface OpenAlexAuthorship {
  author?: OpenAlexNamed | null;
}

export interface OpenAlexLocation {
  source?: OpenAlexNamed | null;
}

export interface OpenAlexWork {
  id?: string | null;
  doi?: string | null;
  display_name?: string | null;
  title?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  authorships?: OpenAlexAuthorship[] | null;
  primary_location?: OpenAlexLocation | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  referenced_works?: (string | null)[] | null;
  topics?: OpenAlexNamed[] | null;
  concepts?: OpenAlexNamed[] | null;
}

export interface OpenAlexWorksResponse {
  results?: OpenAlexWork[] | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (no network) — exported so they can be unit tested directly.
// ---------------------------------------------------------------------------

/**
 * Normalize a DOI to a bare, lowercase form: strips a `https://doi.org/`
 * prefix or a leading `doi:` tag, trims whitespace, and lowercases.
 */
export function normalizeDoi(raw: string): string {
  let doi = raw.trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  doi = doi.replace(/^doi:/i, "");
  return doi.trim().toLowerCase();
}

/**
 * Reduce an OpenAlex id — which may be a full URL like
 * `https://openalex.org/W2741809807` or already-bare — to its short form
 * (`W2741809807`).
 */
export function shortOpenAlexId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  const tail = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  return tail.toUpperCase();
}

/**
 * Rebuild plain text from OpenAlex's `abstract_inverted_index` (a map of
 * word -> the positions it occupies in the abstract). Returns "" for
 * missing/empty input.
 */
export function reconstructAbstract(
  inverted: Record<string, number[]> | null | undefined
): string {
  if (!inverted) return "";

  const positioned: Array<[number, string]> = [];
  for (const word of Object.keys(inverted)) {
    const positions = inverted[word];
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === "number" && Number.isFinite(pos)) {
        positioned.push([pos, word]);
      }
    }
  }

  if (positioned.length === 0) return "";

  positioned.sort((a, b) => a[0] - b[0]);
  return positioned.map(([, word]) => word).join(" ");
}

function nonEmpty(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * Convert a raw OpenAlex work into the game's `Paper` type. Returns null if
 * the work is too broken to use (no title, or no usable id).
 */
export function toPaper(work: OpenAlexWork): Paper | null {
  const title = nonEmpty(work.display_name) || nonEmpty(work.title);
  const rawId = nonEmpty(work.id);
  if (!title || !rawId) return null;

  const shortId = shortOpenAlexId(rawId);
  if (!shortId) return null;

  const doi = work.doi ? normalizeDoi(work.doi) : "";
  const canonicalId = doi ? `doi:${doi}` : `oa:${shortId}`;

  const aliases = new Set<string>();
  aliases.add(`oa:${shortId}`);
  if (doi) aliases.add(`doi:${doi}`);
  aliases.delete(canonicalId);

  const authors = (work.authorships ?? [])
    .map((a) => nonEmpty(a.author?.display_name))
    .filter((name) => name.length > 0);

  const venue = nonEmpty(work.primary_location?.source?.display_name);

  const topicSource =
    work.topics && work.topics.length > 0 ? work.topics : work.concepts ?? [];
  const keywords = (topicSource ?? [])
    .map((k) => nonEmpty(k.display_name))
    .filter((k) => k.length > 0)
    .slice(0, MAX_KEYWORDS);

  const references = (work.referenced_works ?? [])
    .filter((r): r is string => !!r && r.trim().length > 0)
    .slice(0, MAX_REFERENCES)
    .map((r) => `oa:${shortOpenAlexId(r)}`);

  const year =
    typeof work.publication_year === "number" && Number.isFinite(work.publication_year)
      ? work.publication_year
      : 0;
  const citedByCount =
    typeof work.cited_by_count === "number" && Number.isFinite(work.cited_by_count)
      ? work.cited_by_count
      : 0;

  const paper: Paper = {
    id: canonicalId,
    title,
    authors,
    year,
    venue,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    keywords,
    citedByCount,
    references,
    doi: doi || undefined,
    url: doi ? `https://doi.org/${doi}` : undefined,
    source: "openalex",
    fetchedAt: new Date().toISOString(),
    aliases: aliases.size > 0 ? Array.from(aliases) : undefined,
  };

  return paper;
}

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

function clampPerPage(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PER_PAGE;
  return Math.min(Math.max(Math.floor(n), 1), MAX_PER_PAGE);
}

function buildUrl(
  path: string,
  params: Record<string, string | number | undefined>
): string {
  const url = new URL(`${OPENALEX_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("mailto", CONTACT);
  return url.toString();
}

async function openAlexFetch(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAlex request failed: ${message}`);
  }
  if (!response.ok) {
    throw new Error(
      `OpenAlex request failed with status ${response.status} ${response.statusText} for ${url}`
    );
  }
  return response.json();
}

function looksLikeDoi(value: string): boolean {
  const v = value.toLowerCase();
  return v.startsWith("10.") || v.includes("doi.org/");
}

/** Search OpenAlex works by free text query. */
export async function searchWorks(
  query: string,
  opts: { perPage?: number; signal?: AbortSignal } = {}
): Promise<Paper[]> {
  const perPage = clampPerPage(opts.perPage ?? DEFAULT_PER_PAGE);
  const url = buildUrl("/works", {
    search: query,
    "per-page": perPage,
    select: SELECT_FIELDS,
  });
  const data = (await openAlexFetch(url, opts.signal)) as OpenAlexWorksResponse;
  const papers: Paper[] = [];
  for (const work of data.results ?? []) {
    const paper = toPaper(work);
    if (paper) papers.push(paper);
  }
  return papers;
}

/**
 * Fetch a single work by id. Accepts a raw DOI, a `doi:`-prefixed id, an
 * `oa:`-prefixed id, or a bare/URL-form OpenAlex id (`W123...`).
 */
export async function fetchWorkById(
  id: string,
  opts: { signal?: AbortSignal } = {}
): Promise<Paper | null> {
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();

  let path: string;
  if (lower.startsWith("doi:")) {
    path = `/works/doi:${normalizeDoi(trimmed)}`;
  } else if (lower.startsWith("oa:")) {
    path = `/works/${shortOpenAlexId(trimmed.slice(3))}`;
  } else if (looksLikeDoi(trimmed)) {
    path = `/works/doi:${normalizeDoi(trimmed)}`;
  } else {
    path = `/works/${shortOpenAlexId(trimmed)}`;
  }

  const url = buildUrl(path, { select: SELECT_FIELDS });
  const work = (await openAlexFetch(url, opts.signal)) as OpenAlexWork;
  return toPaper(work);
}

async function fetchWorksByShortIds(
  shortIds: string[],
  signal?: AbortSignal
): Promise<Paper[]> {
  const papers: Paper[] = [];
  for (let i = 0; i < shortIds.length; i += ID_BATCH_SIZE) {
    const chunk = shortIds.slice(i, i + ID_BATCH_SIZE);
    if (chunk.length === 0) continue;
    const url = buildUrl("/works", {
      filter: `openalex_id:${chunk.join("|")}`,
      "per-page": chunk.length,
      select: SELECT_FIELDS,
    });
    const data = (await openAlexFetch(url, signal)) as OpenAlexWorksResponse;
    for (const work of data.results ?? []) {
      const paper = toPaper(work);
      if (paper) papers.push(paper);
    }
  }
  return papers;
}

/** Find the OpenAlex short id (`W123...`) a paper is known by, if any. */
function extractOwnShortId(paper: Paper): string | null {
  const candidates = [paper.id, ...(paper.aliases ?? [])];
  for (const candidate of candidates) {
    if (candidate.startsWith("oa:")) return candidate.slice(3);
  }
  return null;
}

/**
 * Expand outward from a known paper: fetch the works it cites (from its
 * `references`) and the works that cite it, so the caller can push back the
 * map's fog. Results are de-duplicated by canonical id.
 */
export async function fetchRelatedWorks(
  paper: Paper,
  opts: { perPage?: number; signal?: AbortSignal } = {}
): Promise<Paper[]> {
  const perPage = clampPerPage(opts.perPage ?? DEFAULT_PER_PAGE);
  const seen = new Set<string>();
  const papers: Paper[] = [];

  const addPaper = (p: Paper | null): void => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    papers.push(p);
  };

  const refShortIds = paper.references
    .filter((r) => r.startsWith("oa:"))
    .map((r) => r.slice(3))
    .slice(0, perPage);

  if (refShortIds.length > 0) {
    const referenced = await fetchWorksByShortIds(refShortIds, opts.signal);
    for (const p of referenced) addPaper(p);
  }

  // Resolve an OpenAlex short ID for citing-works lookup.
  let ownShortId = extractOwnShortId(paper);

  // If the paper has no oa: ID but has a DOI, try to look up its OpenAlex ID
  // so we can still find works that cite this paper.
  if (!ownShortId && paper.doi) {
    try {
      const byDoi = await fetchWorkById(paper.doi, opts);
      if (byDoi) ownShortId = extractOwnShortId(byDoi);
    } catch {
      // Paper may not exist on OpenAlex; silently fall through.
    }
  }

  // Last resort: title search.  This handles seed/demo papers whose titles
  // are real (e.g. "Attention Is All You Need") but whose ids are synthetic.
  if (!ownShortId && paper.title) {
    try {
      const searchResults = await searchWorks(paper.title, { perPage: 1, signal: opts.signal });
      if (searchResults.length > 0) ownShortId = extractOwnShortId(searchResults[0]);
    } catch {
      // Silently fall through.
    }
  }

  if (ownShortId) {
    const url = buildUrl("/works", {
      filter: `cites:${ownShortId}`,
      "per-page": perPage,
      select: SELECT_FIELDS,
    });
    const data = (await openAlexFetch(url, opts.signal)) as OpenAlexWorksResponse;
    for (const work of data.results ?? []) {
      addPaper(toPaper(work));
    }
  }

  return papers;
}

/**
 * Fetch metadata (abstract + keywords) for a paper that may be missing them.
 *
 * Uses the paper's DOI or OpenAlex id if available; falls back to a title
 * search. Returns just the enriched fields so the caller can update the paper
 * in-place without disturbing the rest of its data.
 */
export async function fetchPaperMetadata(
  paper: Paper,
  opts: { signal?: AbortSignal } = {},
): Promise<{ abstract: string; keywords: string[]; citedByCount: number } | null> {
  // 从 paper.id、aliases 和 paper.doi 中收集可用的标识符
  const candidates = [paper.id, ...(paper.aliases ?? [])];
  if (paper.doi) candidates.push(`doi:${normalizeDoi(paper.doi)}`);
  const doiCandidate = candidates.find((id) => id.startsWith("doi:"));
  const oaCandidate = candidates.find((id) => id.startsWith("oa:"));

  let work: OpenAlexWork | null = null;

  // Try DOI first (most reliable)
  if (doiCandidate) {
    try {
      work = (await openAlexFetch(
        buildUrl(`/works/doi:${normalizeDoi(doiCandidate)}`, { select: SELECT_FIELDS }),
        opts.signal,
      )) as OpenAlexWork;
    } catch {
      // Fall through to next method
    }
  }

  // Fall back to OpenAlex id
  if (!work && oaCandidate) {
    try {
      work = (await openAlexFetch(
        buildUrl(`/works/${shortOpenAlexId(oaCandidate.slice(3))}`, { select: SELECT_FIELDS }),
        opts.signal,
      )) as OpenAlexWork;
    } catch {
      // Fall through to title search
    }
  }

  // Last resort: search by title, pick the best match
  if (!work && paper.title.trim()) {
    try {
      const searchQuery = paper.title.replace(/[^\w\s]/g, "").slice(0, 200);
      const data = (await openAlexFetch(
        buildUrl("/works", { search: searchQuery, "per-page": 5, select: SELECT_FIELDS }),
        opts.signal,
      )) as OpenAlexWorksResponse;
      if (data.results && data.results.length > 0) {
        // Prefer the result whose year matches, otherwise take the first
        work =
          data.results.find(
            (r) => r.publication_year === paper.year,
          ) ?? data.results[0];
      }
    } catch {
      return null;
    }
  }

  if (!work) return null;

  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const topicSource = work.topics && work.topics.length > 0 ? work.topics : work.concepts ?? [];
  const keywords = (topicSource ?? [])
    .map((k) => nonEmpty(k.display_name))
    .filter((k) => k.length > 0)
    .slice(0, MAX_KEYWORDS);

  const citedByCount =
    typeof work.cited_by_count === "number" && Number.isFinite(work.cited_by_count)
      ? Math.max(0, work.cited_by_count)
      : 0;

  // 即使摘要和关键词都为空，只要 work 存在就返回结果（可能包含 citedByCount）
  return { abstract, keywords, citedByCount };
}
