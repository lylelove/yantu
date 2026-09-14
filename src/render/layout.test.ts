import { describe, expect, it } from "vitest";

import { deriveEdges } from "../game/edges";
import { deriveRegions } from "../game/regions";
import type { Paper } from "../game/types";
import { computeLayout, layoutBounds, radiusFor } from "./layout";

/**
 * Layout tests.
 *
 * The claim these exist to defend: the map is a *map*. If the same corpus laid
 * out differently on every load, no one could build a mental picture of their
 * own field, which is the entire point of the app. So determinism and stability
 * under growth are treated as correctness properties, not niceties.
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
    source: "seed",
    ...over,
  };
}

/** Two clearly separate topics, so regions have something to separate. */
const corpus: Paper[] = [
  paper("a1", { keywords: ["alpha", "shared-a"] }),
  paper("a2", { keywords: ["alpha", "shared-a"] }),
  paper("a3", { keywords: ["alpha", "shared-a"] }),
  paper("b1", { keywords: ["beta", "shared-b"] }),
  paper("b2", { keywords: ["beta", "shared-b"] }),
  paper("b3", { keywords: ["beta", "shared-b"] }),
];

function layoutOf(papers: Paper[] = corpus, opts = {}) {
  const edges = deriveEdges(papers);
  const regions = deriveRegions(papers);
  return computeLayout(papers, edges, regions, { width: 1200, height: 800, ...opts });
}

describe("radiusFor", () => {
  it("gives uncited papers a floor size", () => {
    expect(radiusFor(paper("x", { citedByCount: 0 }))).toBeGreaterThan(0);
  });

  it("grows with citations but stays bounded", () => {
    const small = radiusFor(paper("x", { citedByCount: 10 }));
    const big = radiusFor(paper("y", { citedByCount: 10_000 }));
    const huge = radiusFor(paper("z", { citedByCount: 1_000_000 }));
    expect(big).toBeGreaterThan(small);
    // Log-scaled and capped: a landmark paper must not swallow the map.
    expect(huge).toBeLessThan(small * 5);
  });

  it("is monotonic in citation count", () => {
    const counts = [0, 1, 10, 100, 1000, 50_000];
    const radii = counts.map((c) => radiusFor(paper("x", { citedByCount: c })));
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1]);
    }
  });
});

describe("computeLayout", () => {
  it("places every paper", () => {
    const layout = layoutOf();
    expect(layout.nodes.size).toBe(corpus.length);
  });

  it("produces finite coordinates", () => {
    // A single NaN propagates through the force simulation and blanks the map.
    for (const node of layoutOf().nodes.values()) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("is deterministic for the same corpus", () => {
    const a = layoutOf();
    const b = layoutOf();
    for (const [id, na] of a.nodes) {
      const nb = b.nodes.get(id)!;
      expect(nb.x).toBeCloseTo(na.x, 6);
      expect(nb.y).toBeCloseTo(na.y, 6);
    }
  });

  it("does not depend on the order papers arrive in", () => {
    // Imports and online expansions deliver papers in arbitrary order; the map
    // must not rearrange itself because of that. Float accumulation differs
    // with iteration order, so this asserts "recognisably the same place"
    // rather than bit-identical coordinates.
    const a = layoutOf(corpus);
    const b = layoutOf([...corpus].reverse());
    for (const [id, na] of a.nodes) {
      const nb = b.nodes.get(id)!;
      expect(Math.hypot(nb.x - na.x, nb.y - na.y)).toBeLessThan(25);
    }
  });

  it("keeps papers of one region closer to each other than to the other region", () => {
    const layout = layoutOf();
    const centroid = (ids: string[]) => {
      const ns = ids.map((id) => layout.nodes.get(id)!);
      return {
        x: ns.reduce((s, n) => s + n.x, 0) / ns.length,
        y: ns.reduce((s, n) => s + n.y, 0) / ns.length,
      };
    };
    const ca = centroid(["a1", "a2", "a3"]);
    const cb = centroid(["b1", "b2", "b3"]);
    const between = Math.hypot(ca.x - cb.x, ca.y - cb.y);

    // Every alpha paper should sit nearer its own centroid than the beta one.
    for (const id of ["a1", "a2", "a3"]) {
      const n = layout.nodes.get(id)!;
      expect(Math.hypot(n.x - ca.x, n.y - ca.y)).toBeLessThan(between);
    }
  });

  it("separates coincident nodes instead of stacking them", () => {
    // Papers with identical metadata would otherwise land on one pixel.
    const twins = [paper("t1", { keywords: ["k"] }), paper("t2", { keywords: ["k"] })];
    const layout = layoutOf(twins);
    const a = layout.nodes.get("t1")!;
    const b = layout.nodes.get("t2")!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1);
  });

  it("reuses prior positions when new papers arrive", () => {
    // Adding a paper must not reshuffle the map the user has already learned.
    const first = layoutOf(corpus);
    const grown = layoutOf([...corpus, paper("c1", { keywords: ["gamma"] })], {
      previous: first,
      iterations: 1,
    });
    const before = first.nodes.get("a1")!;
    const after = grown.nodes.get("a1")!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(30);
  });

  it("handles an empty corpus", () => {
    const layout = computeLayout([], [], []);
    expect(layout.nodes.size).toBe(0);
    expect(layout.regionCentres.size).toBe(0);
  });

  it("centres a lone region rather than pushing it to a ring", () => {
    const solo = [paper("s1", { keywords: ["only"] }), paper("s2", { keywords: ["only"] })];
    const layout = layoutOf(solo);
    const regions = deriveRegions(solo);
    const centre = layout.regionCentres.get(regions[0].id)!;
    expect(centre.x).toBeCloseTo(600, 0);
    expect(centre.y).toBeCloseTo(400, 0);
  });

  it("gives a region the same bearing regardless of corpus order", () => {
    const regions = deriveRegions(corpus);
    const a = layoutOf(corpus).regionCentres.get(regions[0].id)!;
    const b = layoutOf([...corpus].reverse()).regionCentres.get(regions[0].id)!;
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  });
});

describe("layoutBounds", () => {
  it("covers every node", () => {
    const layout = layoutOf();
    const b = layoutBounds(layout);
    for (const n of layout.nodes.values()) {
      expect(n.x).toBeGreaterThanOrEqual(b.minX);
      expect(n.x).toBeLessThanOrEqual(b.maxX);
      expect(n.y).toBeGreaterThanOrEqual(b.minY);
      expect(n.y).toBeLessThanOrEqual(b.maxY);
    }
  });

  it("falls back to the canvas size when there is nothing to bound", () => {
    const b = layoutBounds(computeLayout([], [], [], { width: 900, height: 500 }));
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 900, maxY: 500 });
  });
});
