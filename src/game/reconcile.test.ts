import { describe, expect, it } from "vitest";

import { reconcile, remapProgress } from "./reconcile";
import type { Paper, PaperId, PaperProgress } from "./types";
import { buildWorld, emptySave } from "./world";

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

const byId = (papers: Paper[], id: PaperId) => papers.find((p) => p.id === id);

describe("reconcile", () => {
  it("leaves unrelated papers alone", () => {
    const { papers, mergedCount } = reconcile([paper("doi:10.1/a"), paper("doi:10.1/b")]);
    expect(papers).toHaveLength(2);
    expect(mergedCount).toBe(0);
  });

  it("collapses two records that share an identifier", () => {
    // The same work: imported by DOI, and fetched from OpenAlex.
    const imported = paper("doi:10.1/x", { source: "import", title: "Attention" });
    const fetched = paper("oa:W1", { aliases: ["doi:10.1/x"], citedByCount: 900 });
    const { papers, mergedCount } = reconcile([imported, fetched]);

    expect(papers).toHaveLength(1);
    expect(mergedCount).toBe(1);
    expect(papers[0].id).toBe("doi:10.1/x");
    expect(papers[0].aliases).toContain("oa:W1");
  });

  it("prefers a DOI as the canonical id over an OpenAlex or local key", () => {
    const { papers } = reconcile([
      paper("local:abc", { aliases: ["doi:10.1/x"] }),
      paper("oa:W1", { aliases: ["doi:10.1/x"] }),
    ]);
    expect(papers).toHaveLength(1);
    expect(papers[0].id).toBe("doi:10.1/x");
  });

  it("links records transitively through a shared alias", () => {
    // A shares an alias with B, B with C: all three are one work.
    const { papers } = reconcile([
      paper("oa:W1", { aliases: ["arxiv:1706.03762"] }),
      paper("local:k", { aliases: ["arxiv:1706.03762", "doi:10.1/x"] }),
      paper("doi:10.1/x"),
    ]);
    expect(papers).toHaveLength(1);
    expect(papers[0].id).toBe("doi:10.1/x");
  });

  it("lets the user's own record win on contested fields", () => {
    // A corrected title must survive a later online expansion of the work.
    const { papers } = reconcile([
      paper("oa:W1", { aliases: ["doi:10.1/x"], title: "attention is all you need" }),
      paper("doi:10.1/x", { source: "manual", title: "Attention Is All You Need" }),
    ]);
    expect(papers[0].title).toBe("Attention Is All You Need");
  });

  it("fills blank fields from the weaker record instead of leaving gaps", () => {
    const { papers } = reconcile([
      paper("doi:10.1/x", { source: "import", venue: "", year: 0, abstract: "" }),
      paper("oa:W1", {
        aliases: ["doi:10.1/x"],
        venue: "NeurIPS",
        year: 2017,
        abstract: "long abstract",
        citedByCount: 500,
      }),
    ]);
    expect(papers[0]).toMatchObject({
      venue: "NeurIPS",
      year: 2017,
      abstract: "long abstract",
      citedByCount: 500,
    });
  });

  it("unions keywords and takes the fullest author list", () => {
    const { papers } = reconcile([
      paper("doi:10.1/x", { source: "import", keywords: ["a"], authors: ["Vaswani"] }),
      paper("oa:W1", {
        aliases: ["doi:10.1/x"],
        keywords: ["b"],
        authors: ["Vaswani", "Shazeer", "Parmar"],
      }),
    ]);
    expect(new Set(papers[0].keywords)).toEqual(new Set(["a", "b"]));
    expect(papers[0].authors).toEqual(["Vaswani", "Shazeer", "Parmar"]);
  });

  it("rewrites citations onto canonical ids", () => {
    // This is the bug reconciliation exists to prevent: a citation by OpenAlex
    // id must resolve to the paper the user owns by DOI, or no edge forms.
    const { papers } = reconcile([
      paper("oa:W_citing", { references: ["oa:W_cited"] }),
      paper("doi:10.1/cited", { source: "import", aliases: ["oa:W_cited"] }),
    ]);
    expect(byId(papers, "oa:W_citing")!.references).toEqual(["doi:10.1/cited"]);
  });

  it("drops a self-citation created by merging two records", () => {
    const { papers } = reconcile([
      paper("doi:10.1/x", { source: "import", references: ["oa:W1"] }),
      paper("oa:W1", { aliases: ["doi:10.1/x"] }),
    ]);
    expect(papers[0].references).toEqual([]);
  });

  it("keeps references to works we do not hold", () => {
    const { papers } = reconcile([paper("oa:W1", { references: ["oa:W_unknown"] })]);
    expect(papers[0].references).toEqual(["oa:W_unknown"]);
  });

  it("is order-independent", () => {
    const input = [
      paper("oa:W1", { aliases: ["doi:10.1/x"], citedByCount: 5 }),
      paper("doi:10.1/x", { source: "import" }),
      paper("doi:10.1/other"),
    ];
    const a = reconcile(input);
    const b = reconcile([...input].reverse());
    expect(JSON.stringify(a.papers)).toBe(JSON.stringify(b.papers));
  });

  it("maps every known identifier to its canonical id", () => {
    const { aliasIndex } = reconcile([
      paper("oa:W1", { aliases: ["arxiv:1", "doi:10.1/x"] }),
      paper("doi:10.1/x"),
    ]);
    expect(aliasIndex.get("oa:W1")).toBe("doi:10.1/x");
    expect(aliasIndex.get("arxiv:1")).toBe("doi:10.1/x");
    expect(aliasIndex.get("doi:10.1/x")).toBe("doi:10.1/x");
  });
});

describe("remapProgress", () => {
  const progressOf = (e: Record<PaperId, Partial<PaperProgress>>) => {
    const out: Record<PaperId, PaperProgress> = {};
    for (const [id, pr] of Object.entries(e)) out[id] = { state: "unread", note: "", ...pr };
    return out;
  };

  it("moves progress onto the canonical id", () => {
    // Otherwise a paper read under its OpenAlex id comes back unread once the
    // user's DOI-keyed library arrives.
    const index = new Map([["oa:W1", "doi:10.1/x"]]);
    const out = remapProgress(progressOf({ "oa:W1": { state: "read" } }), index);
    expect(out["doi:10.1/x"].state).toBe("read");
    expect(out["oa:W1"]).toBeUndefined();
  });

  it("keeps the furthest-along state when both ids carry progress", () => {
    const index = new Map([
      ["oa:W1", "doi:10.1/x"],
      ["doi:10.1/x", "doi:10.1/x"],
    ]);
    const out = remapProgress(
      progressOf({ "oa:W1": { state: "read" }, "doi:10.1/x": { state: "reading" } }),
      index,
    );
    expect(out["doi:10.1/x"].state).toBe("read");
  });

  it("preserves notes from both records", () => {
    const index = new Map([
      ["oa:W1", "doi:10.1/x"],
      ["doi:10.1/x", "doi:10.1/x"],
    ]);
    const out = remapProgress(
      progressOf({
        "oa:W1": { state: "read", note: "first thought" },
        "doi:10.1/x": { state: "read", note: "second thought" },
      }),
      index,
    );
    expect(out["doi:10.1/x"].note).toContain("first thought");
    expect(out["doi:10.1/x"].note).toContain("second thought");
  });

  it("leaves untracked ids untouched", () => {
    const out = remapProgress(progressOf({ "doi:10.1/y": { state: "read" } }), new Map());
    expect(out["doi:10.1/y"].state).toBe("read");
  });
});

describe("buildWorld with duplicate records", () => {
  it("lights a cited paper the user owns under a different identifier", () => {
    // End-to-end proof of the fog consequence: reading the citing paper must
    // illuminate the cited one even though the two arrived from different
    // sources under different ids.
    const save = {
      ...emptySave(),
      papers: {
        "doi:10.1/citing": paper("doi:10.1/citing", {
          source: "import",
          references: ["oa:W_cited"],
        }),
        "oa:W_cited": paper("oa:W_cited", { aliases: ["doi:10.1/cited"] }),
        "doi:10.1/cited": paper("doi:10.1/cited", { source: "import" }),
      },
      progress: {
        "doi:10.1/citing": { state: "read" as const, note: "" },
      },
    };

    const world = buildWorld(save);
    // Three records, two works.
    expect(world.papers).toHaveLength(2);
    expect(world.edges.some((e) => e.kind === "cites")).toBe(true);
    expect(world.visibility["doi:10.1/cited"]).not.toBe("fog");
  });

  it("counts merged duplicates once in its stats", () => {
    const save = {
      ...emptySave(),
      papers: {
        a: paper("a", { source: "import", aliases: ["dup"] }),
        dup: paper("dup", { source: "import" }),
      },
    };
    expect(buildWorld(save).stats.known).toBe(1);
  });
});
