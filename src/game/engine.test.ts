import { describe, expect, it } from "vitest";

import { buildAdjacency, deriveEdges } from "./edges";
import { computeFog } from "./fog";
import { scoreLeads } from "./leads";
import { deriveRegions, regionIndex, UNSORTED_REGION } from "./regions";
import type { Paper, PaperId, PaperProgress } from "./types";
import { buildWorld, emptySave } from "./world";

/** Terse paper factory. Defaults are "online, unknown, uncited". */
function paper(id: string, over: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: [],
    year: 2020,
    venue: "",
    abstract: "",
    keywords: [],
    citedByCount: 0,
    references: [],
    source: "openalex",
    ...over,
  };
}

function progressOf(entries: Record<PaperId, Partial<PaperProgress>>): Record<PaperId, PaperProgress> {
  const out: Record<PaperId, PaperProgress> = {};
  for (const [id, pr] of Object.entries(entries)) {
    out[id] = { state: "unread", note: "", ...pr };
  }
  return out;
}

function saveOf(papers: Paper[], progress: Record<PaperId, PaperProgress> = {}) {
  return {
    ...emptySave(),
    papers: Object.fromEntries(papers.map((p) => [p.id, p])),
    progress,
  };
}

describe("deriveEdges", () => {
  it("only creates citation edges to papers we actually hold", () => {
    const papers = [paper("a", { references: ["b", "ghost"] }), paper("b")];
    const cites = deriveEdges(papers).filter((e) => e.kind === "cites");
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("ignores self-citations", () => {
    const papers = [paper("a", { references: ["a"] })];
    expect(deriveEdges(papers).filter((e) => e.kind === "cites")).toHaveLength(0);
  });

  it("drops keyword pairs below the similarity floor", () => {
    // 1 shared term out of 9 distinct => jaccard 0.11, under the 0.18 floor.
    const papers = [
      paper("a", { keywords: ["shared", "a1", "a2", "a3", "a4"] }),
      paper("b", { keywords: ["shared", "b1", "b2", "b3", "b4"] }),
    ];
    expect(deriveEdges(papers).filter((e) => e.kind === "keyword")).toHaveLength(0);
  });

  it("keeps strongly overlapping keyword pairs, once", () => {
    const papers = [
      paper("a", { keywords: ["graph", "fog"] }),
      paper("b", { keywords: ["graph", "fog"] }),
    ];
    const kw = deriveEdges(papers).filter((e) => e.kind === "keyword");
    expect(kw).toHaveLength(1);
    expect(kw[0].weight).toBeCloseTo(1);
  });

  it("normalises keywords and authors before matching", () => {
    const papers = [
      paper("a", { keywords: ["  Causal  Inference "], authors: ["Jane Doe"] }),
      paper("b", { keywords: ["causal inference"], authors: ["  jane   doe  "] }),
    ];
    const edges = deriveEdges(papers);
    expect(edges.some((e) => e.kind === "keyword")).toBe(true);
    expect(edges.some((e) => e.kind === "coauthor")).toBe(true);
  });

  it("only links same-venue papers published close together", () => {
    const near = deriveEdges([
      paper("a", { venue: "NeurIPS", year: 2020 }),
      paper("b", { venue: "NeurIPS", year: 2022 }),
    ]);
    const far = deriveEdges([
      paper("a", { venue: "NeurIPS", year: 2004 }),
      paper("b", { venue: "NeurIPS", year: 2022 }),
    ]);
    expect(near.some((e) => e.kind === "venue")).toBe(true);
    expect(far.some((e) => e.kind === "venue")).toBe(false);
  });

  it("survives ids containing spaces", () => {
    // Guards the pair-key encoding: ids must never be parsed back out of a key.
    const papers = [
      paper("doi 10.1/a", { keywords: ["x", "y"] }),
      paper("doi 10.1/b", { keywords: ["x", "y"] }),
    ];
    const kw = deriveEdges(papers).filter((e) => e.kind === "keyword");
    expect(kw).toHaveLength(1);
    expect(new Set([kw[0].source, kw[0].target])).toEqual(
      new Set(["doi 10.1/a", "doi 10.1/b"]),
    );
  });

  it("builds undirected adjacency keeping the strongest relation", () => {
    const papers = [
      paper("a", { references: ["b"], keywords: ["k1", "k2"], venue: "V", year: 2020 }),
      paper("b", { keywords: ["k1", "k2"], venue: "V", year: 2020 }),
    ];
    const adj = buildAdjacency(papers, deriveEdges(papers));
    // cites (1.0) beats venue (0.25); the link is traversable both ways.
    expect(adj.get("a")!.get("b")).toBe(1);
    expect(adj.get("b")!.get("a")).toBe(1);
  });
});

describe("deriveRegions", () => {
  const corpus = [
    paper("a1", { keywords: ["causal inference", "graphs"] }),
    paper("a2", { keywords: ["causal inference"] }),
    paper("a3", { keywords: ["causal inference"] }),
    paper("b1", { keywords: ["representation learning"] }),
    paper("b2", { keywords: ["representation learning"] }),
    paper("lonely", { keywords: ["a keyword nobody else uses"] }),
  ];

  it("assigns every paper to exactly one region", () => {
    const regions = deriveRegions(corpus);
    const seen = corpus.map((p) => regions.filter((r) => r.members.includes(p.id)).length);
    expect(seen.every((n) => n === 1)).toBe(true);
  });

  it("seeds the largest cluster first and names it after its keyword", () => {
    const regions = deriveRegions(corpus);
    expect(regions[0].name).toBe("causal inference");
    expect(regions[0].members).toEqual(["a1", "a2", "a3"]);
  });

  it("folds papers with no shared keyword into the unsorted region", () => {
    const regions = deriveRegions(corpus);
    const unsorted = regions.find((r) => r.id === UNSORTED_REGION);
    expect(unsorted?.members).toEqual(["lonely"]);
  });

  it("is deterministic across runs", () => {
    expect(JSON.stringify(deriveRegions(corpus))).toBe(JSON.stringify(deriveRegions(corpus)));
  });

  it("gives a region a stable hue regardless of corpus order", () => {
    const a = deriveRegions(corpus).find((r) => r.name === "causal inference")!;
    const b = deriveRegions([...corpus].reverse()).find((r) => r.name === "causal inference")!;
    expect(a.hue).toBe(b.hue);
  });

  it("indexes papers back to their region", () => {
    const idx = regionIndex(deriveRegions(corpus));
    expect(idx.get("b1")!.name).toBe("representation learning");
  });
});

describe("computeFog", () => {
  /** A citation chain of online papers hanging off one owned paper. */
  const chain = [
    paper("root", { source: "import", references: ["x1"] }),
    paper("x1", { references: ["x2"] }),
    paper("x2", { references: ["x3"] }),
    paper("x3"),
  ];

  function fogOf(progress: Record<PaperId, PaperProgress>) {
    const edges = deriveEdges(chain);
    return computeFog(chain, progress, buildAdjacency(chain, edges)).visibility;
  }

  it("keeps imported papers visible even before they are read", () => {
    // The user's own library is the known world; hiding it would be a lie.
    expect(fogOf(progressOf({}))["root"]).toBe("frontier");
  });

  it("hides online papers until something lit points at them", () => {
    const v = fogOf(progressOf({}));
    expect(v["x1"]).toBe("fog");
    expect(v["x3"]).toBe("fog");
  });

  it("reveals one hop as frontier and two as sensed when a paper is read", () => {
    const v = fogOf(progressOf({ root: { state: "read" } }));
    expect(v["root"]).toBe("lit");
    expect(v["x1"]).toBe("frontier");
    expect(v["x2"]).toBe("sensed");
    expect(v["x3"]).toBe("fog");
  });

  it("reaches one hop further once the read paper is annotated", () => {
    const v = fogOf(progressOf({ root: { state: "read", note: "why this matters" } }));
    expect(v["root"]).toBe("beacon");
    expect(v["x1"]).toBe("frontier");
    expect(v["x2"]).toBe("frontier");
    expect(v["x3"]).toBe("sensed");
  });

  it("treats a paper in progress as identified", () => {
    expect(fogOf(progressOf({ x1: { state: "reading" } }))["x1"]).toBe("frontier");
  });

  it("does not propagate light along weak venue-only links", () => {
    // Venue weight 0.25 sits below the propagation floor of 0.3.
    const papers = [
      paper("a", { source: "import", venue: "NeurIPS", year: 2020 }),
      paper("b", { venue: "NeurIPS", year: 2020 }),
    ];
    const adj = buildAdjacency(papers, deriveEdges(papers));
    const { visibility } = computeFog(papers, progressOf({ a: { state: "read" } }), adj);
    expect(visibility["b"]).toBe("fog");
  });

  it("reports how far the lit set currently projects", () => {
    const edges = deriveEdges(chain);
    const adj = buildAdjacency(chain, edges);
    expect(computeFog(chain, progressOf({}), adj).visionRadius).toBe(0);
    expect(computeFog(chain, progressOf({ root: { state: "read" } }), adj).visionRadius).toBe(2);
  });
});

describe("scoreLeads", () => {
  // "alpha" is well explored; "beta" is untouched but reachable via a citation.
  const corpus = [
    paper("a1", { source: "import", keywords: ["alpha"], references: ["b1"] }),
    paper("a2", { source: "import", keywords: ["alpha"] }),
    paper("a3", { source: "import", keywords: ["alpha"] }),
    paper("b1", { keywords: ["beta"] }),
    paper("b2", { keywords: ["beta"] }),
  ];

  function leadsFor(progress: Record<PaperId, PaperProgress>) {
    const edges = deriveEdges(corpus);
    const adj = buildAdjacency(corpus, edges);
    const { visibility } = computeFog(corpus, progress, adj);
    const regions = deriveRegions(corpus);
    return scoreLeads({
      papers: corpus,
      progress,
      adj,
      visibility,
      regions,
      regionOf: regionIndex(regions),
    });
  }

  const read = progressOf({ a1: { state: "read" }, a2: { state: "read" } });

  it("ranks unexplored territory above a better-connected familiar paper", () => {
    // This is the whole point of the app: a3 has more lit neighbours, but b1
    // opens a region the user has never entered, so b1 must win.
    const leads = leadsFor(read);
    const rank = leads.map((l) => l.paperId);
    expect(rank.indexOf("b1")).toBeGreaterThanOrEqual(0);
    expect(rank.indexOf("b1")).toBeLessThan(rank.indexOf("a3"));
  });

  it("explains itself in terms the user can act on", () => {
    const b1 = leadsFor(read).find((l) => l.paperId === "b1")!;
    expect(b1.novelty).toBeCloseTo(1);
    expect(b1.reasons.join(" ")).toContain("beta");
  });

  it("drops papers already read", () => {
    const leads = leadsFor(read);
    expect(leads.some((l) => l.paperId === "a1" || l.paperId === "a2")).toBe(false);
  });

  it("skips merely-sensed papers that nothing lit points at", () => {
    // b2 is sensed via unread b1, so acting on it would be a leap into nothing.
    expect(leadsFor(read).some((l) => l.paperId === "b2")).toBe(false);
  });

  it("offers the owned library as the starting leads when nothing is read yet", () => {
    // Before any reading, the user's own papers are the only actionable things
    // on the map, so they must be what the panel proposes.
    const leads = leadsFor(progressOf({}));
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => ["a1", "a2", "a3"].includes(l.paperId))).toBe(true);
  });

  it("has nothing to propose for an empty corpus", () => {
    const edges = deriveEdges([]);
    const regions = deriveRegions([]);
    expect(
      scoreLeads({
        papers: [],
        progress: {},
        adj: buildAdjacency([], edges),
        visibility: {},
        regions,
        regionOf: regionIndex(regions),
      }),
    ).toEqual([]);
  });
});

describe("buildWorld", () => {
  it("handles an empty save without throwing", () => {
    const world = buildWorld(emptySave());
    expect(world.papers).toEqual([]);
    expect(world.stats.coverage).toBe(0);
    expect(world.quests).toEqual([]);
  });

  it("derives stats from the visible world, not the whole corpus", () => {
    // Two owned papers read, plus an unreachable online paper that must not
    // drag coverage down — you cannot be faulted for not reading the invisible.
    const papers = [
      paper("a", { source: "import", keywords: ["k1", "k2"] }),
      paper("b", { source: "import", keywords: ["k1", "k2"] }),
      paper("far", { keywords: ["unrelated"] }),
    ];
    const world = buildWorld(
      saveOf(papers, progressOf({ a: { state: "read" }, b: { state: "read" } })),
    );
    expect(world.stats.known).toBe(2);
    expect(world.stats.lit).toBe(2);
    expect(world.stats.coverage).toBe(1);
    expect(world.visibility["far"]).toBe("fog");
  });

  it("counts annotated papers as beacons", () => {
    const papers = [paper("a", { source: "import" })];
    const world = buildWorld(saveOf(papers, progressOf({ a: { state: "read", note: "n" } })));
    expect(world.stats.beacons).toBe(1);
  });

  it("respects user region renames without changing membership", () => {
    const papers = [
      paper("a", { source: "import", keywords: ["topic"] }),
      paper("b", { source: "import", keywords: ["topic"] }),
    ];
    const base = buildWorld(saveOf(papers));
    const renamed = buildWorld({
      ...saveOf(papers),
      regionNames: { [base.regions[0].id]: "我的方向" },
    });
    expect(renamed.regions[0].name).toBe("我的方向");
    expect(renamed.regions[0].members).toEqual(base.regions[0].members);
  });

  it("is pure: the same save always yields the same world", () => {
    const papers = [
      paper("a", { source: "import", keywords: ["k1", "k2"], references: ["b"] }),
      paper("b", { keywords: ["k1", "k2"] }),
    ];
    const save = saveOf(papers, progressOf({ a: { state: "read" } }));
    expect(JSON.stringify(buildWorld(save))).toBe(JSON.stringify(buildWorld(save)));
  });

  it("proposes stepping into a visible but unentered region", () => {
    const papers = [
      paper("a1", { source: "import", keywords: ["alpha"], references: ["b1"] }),
      paper("b1", { keywords: ["beta"] }),
      paper("b2", { keywords: ["beta"] }),
    ];
    const world = buildWorld(saveOf(papers, progressOf({ a1: { state: "read" } })));
    const enter = world.quests.find((q) => q.kind === "enter-region");
    expect(enter?.title).toContain("beta");
  });
});
