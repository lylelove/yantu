import { beforeEach, describe, expect, it } from "vitest";

import type { Paper } from "../game/types";
import { emptySave } from "../game/world";
import { useStore } from "./store";

/**
 * Store tests.
 *
 * These exercise the seam where user actions become durable state, which is
 * where a mistake is least forgiving: a dropped note or a lost read-state is
 * data the user cannot get back by re-running anything.
 *
 * The store is a module singleton, so each test starts by replacing the save
 * wholesale rather than trusting the previous test to have cleaned up.
 */

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
    source: "import",
    ...over,
  };
}

const store = () => useStore.getState();

beforeEach(() => {
  store().replaceSave(emptySave());
});

describe("addPapers", () => {
  it("adds new papers and reports the count", () => {
    const result = store().addPapers([paper("a"), paper("b")]);
    expect(result).toEqual({ added: 2, merged: 0 });
    expect(store().world.papers).toHaveLength(2);
  });

  it("is a no-op for an empty batch", () => {
    expect(store().addPapers([])).toEqual({ added: 0, merged: 0 });
  });

  it("merges a paper arriving under a different identifier", () => {
    // The scenario that matters: the user owns a paper by DOI, then an online
    // expansion returns the same work by OpenAlex id. One node, not two.
    store().addPapers([paper("doi:10.1/x")]);
    const result = store().addPapers([
      paper("oa:W1", { aliases: ["doi:10.1/x"], source: "openalex", citedByCount: 99 }),
    ]);

    expect(result).toEqual({ added: 0, merged: 1 });
    expect(store().world.papers).toHaveLength(1);
    // The merge should have brought the citation count along with it.
    expect(store().world.papers[0].citedByCount).toBe(99);
  });

  it("keeps re-importing the same file idempotent", () => {
    const batch = [paper("a"), paper("b")];
    store().addPapers(batch);
    store().addPapers(batch);
    expect(store().world.papers).toHaveLength(2);
  });
});

describe("read state", () => {
  beforeEach(() => {
    store().addPapers([paper("a")]);
  });

  it("lights a paper when it is marked read", () => {
    store().setReadState("a", "read");
    expect(store().world.visibility["a"]).toBe("lit");
  });

  it("records when a paper first lit up, and keeps that first moment", () => {
    store().setReadState("a", "read");
    const first = store().save.progress["a"].litAt;
    expect(first).toBeTruthy();

    // Cycling back through unread and read again must not rewrite history.
    store().setReadState("a", "unread");
    store().setReadState("a", "mastered");
    expect(store().save.progress["a"].litAt).toBe(first);
  });

  it("promotes a read paper to a beacon once it has a note", () => {
    store().setReadState("a", "read");
    expect(store().world.visibility["a"]).toBe("lit");

    store().setNote("a", "这篇解决了什么");
    expect(store().world.visibility["a"]).toBe("beacon");
  });

  it("does not treat a whitespace-only note as engagement", () => {
    store().setReadState("a", "read");
    store().setNote("a", "   \n  ");
    expect(store().world.visibility["a"]).toBe("lit");
  });

  it("keeps the note when the read state changes", () => {
    store().setNote("a", "keep me");
    store().setReadState("a", "reading");
    expect(store().save.progress["a"].note).toBe("keep me");
  });

  it("exposes progress under the canonical id", () => {
    // The UI reads world.progress; after a merge it must still find the note.
    store().setReadState("a", "read");
    store().setNote("a", "n");
    expect(store().world.progress["a"].note).toBe("n");
  });
});

describe("renameRegion", () => {
  beforeEach(() => {
    store().addPapers([
      paper("a", { keywords: ["topic"] }),
      paper("b", { keywords: ["topic"] }),
    ]);
  });

  it("applies a user name to the derived region", () => {
    const regionId = store().world.regions[0].id;
    store().renameRegion(regionId, "我的方向");
    expect(store().world.regions[0].name).toBe("我的方向");
  });

  it("restores the derived name when cleared", () => {
    const regionId = store().world.regions[0].id;
    const original = store().world.regions[0].name;
    store().renameRegion(regionId, "临时");
    store().renameRegion(regionId, "   ");
    // Blanking a name means "go back to the derived one", not "name it nothing".
    expect(store().world.regions[0].name).toBe(original);
    expect(store().save.regionNames[regionId]).toBeUndefined();
  });
});

describe("manual edges", () => {
  beforeEach(() => {
    store().addPapers([paper("a"), paper("b")]);
  });

  it("creates a user-asserted relation", () => {
    store().addManualEdge("a", "b");
    expect(store().world.edges.some((e) => e.kind === "manual")).toBe(true);
  });

  it("refuses a self-link", () => {
    store().addManualEdge("a", "a");
    expect(store().save.manualEdges).toHaveLength(0);
  });

  it("does not duplicate an existing link in either direction", () => {
    store().addManualEdge("a", "b");
    store().addManualEdge("a", "b");
    store().addManualEdge("b", "a");
    expect(store().save.manualEdges).toHaveLength(1);
  });

  it("removes a link regardless of the order given", () => {
    store().addManualEdge("a", "b");
    store().removeManualEdge("b", "a");
    expect(store().save.manualEdges).toHaveLength(0);
  });

  it("propagates light along a manual link", () => {
    // A user asserting a connection is as strong a claim as a citation.
    store().addManualEdge("a", "b");
    store().setReadState("a", "read");
    expect(store().world.visibility["b"]).not.toBe("fog");
  });
});

describe("session state", () => {
  it("opens the detail panel when a paper is selected", () => {
    store().addPapers([paper("a")]);
    store().select("a");
    expect(store().panel).toBe("paper");
    store().select(null);
    expect(store().panel).toBe("leads");
  });

  it("toggles an edge kind without touching the save", () => {
    const before = store().save.updatedAt;
    store().toggleEdgeKind("venue");
    expect(store().edgeFilter.venue).toBe(true);
    // Filters are ephemeral; they must not dirty the save file.
    expect(store().save.updatedAt).toBe(before);
  });

  it("tracks concurrent background work", () => {
    store().setBusy("expand:a", true);
    store().setBusy("expand:b", true);
    expect(Object.keys(store().busy)).toHaveLength(2);
    store().setBusy("expand:a", false);
    expect(store().busy).toEqual({ "expand:b": true });
  });

  it("clears the map and the session on reset", () => {
    store().addPapers([paper("a")]);
    store().select("a");
    store().setSearch("query");
    store().reset();

    expect(store().world.papers).toHaveLength(0);
    expect(store().selectedId).toBeNull();
    expect(store().search).toBe("");
  });
});

describe("removePapers", () => {
  beforeEach(() => {
    store().addPapers([paper("a"), paper("b"), paper("c")]);
  });

  it("removes specific papers and their progress", () => {
    store().setReadState("a", "read");
    store().removePapers(["a"]);
    expect(store().world.papers).toHaveLength(2);
    expect(store().world.papers.find((p) => p.id === "a")).toBeUndefined();
    expect(store().save.progress["a"]).toBeUndefined();
  });

  it("removes multiple papers at once", () => {
    store().removePapers(["a", "b"]);
    expect(store().world.papers).toHaveLength(1);
    expect(store().world.papers[0].id).toBe("c");
  });

  it("cleans up manual edges referencing removed papers", () => {
    store().addManualEdge("a", "b");
    expect(store().save.manualEdges).toHaveLength(1);
    store().removePapers(["a"]);
    expect(store().save.manualEdges).toHaveLength(0);
  });

  it("is a no-op for an empty list", () => {
    store().removePapers([]);
    expect(store().world.papers).toHaveLength(3);
  });
});

describe("updatePaper", () => {
  beforeEach(() => {
    store().addPapers([paper("a")]);
  });

  it("updates fields on an existing paper", () => {
    store().updatePaper("a", { abstract: "New abstract" });
    expect(store().save.papers["a"].abstract).toBe("New abstract");
  });

  it("updates keywords", () => {
    store().updatePaper("a", { keywords: ["ml", "ai"] });
    expect(store().save.papers["a"].keywords).toEqual(["ml", "ai"]);
  });

  it("preserves other fields when updating", () => {
    store().updatePaper("a", { abstract: "abs" });
    const p = store().save.papers["a"];
    expect(p.title).toBe("Paper a");
    expect(p.year).toBe(2020);
    expect(p.abstract).toBe("abs");
  });

  it("does nothing for a non-existent paper", () => {
    expect(() => store().updatePaper("nonexistent", { abstract: "x" })).not.toThrow();
    expect(store().world.papers).toHaveLength(1);
  });
});
