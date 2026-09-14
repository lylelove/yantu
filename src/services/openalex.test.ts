import { describe, expect, it } from "vitest";

import {
  fetchPaperMetadata,
  normalizeDoi,
  reconstructAbstract,
  shortOpenAlexId,
  toPaper,
  type OpenAlexWork,
} from "./openalex";

describe("reconstructAbstract", () => {
  it("rebuilds text from an inverted index in order", () => {
    const inverted = {
      This: [0],
      is: [1],
      a: [2],
      test: [3],
    };
    expect(reconstructAbstract(inverted)).toBe("This is a test");
  });

  it("handles out-of-order positions and repeated words", () => {
    const inverted = {
      fox: [1, 5],
      the: [0, 4],
      quick: [2],
      jumps: [3],
    };
    // 0:the 1:fox 2:quick 3:jumps 4:the 5:fox
    expect(reconstructAbstract(inverted)).toBe("the fox quick jumps the fox");
  });

  it("returns empty string for null, undefined, and empty input", () => {
    expect(reconstructAbstract(null)).toBe("");
    expect(reconstructAbstract(undefined)).toBe("");
    expect(reconstructAbstract({})).toBe("");
  });
});

describe("normalizeDoi", () => {
  it("passes through a bare doi", () => {
    expect(normalizeDoi("10.1234/abc.DEF")).toBe("10.1234/abc.def");
  });

  it("strips a https://doi.org/ prefix", () => {
    expect(normalizeDoi("https://doi.org/10.1234/AbC")).toBe("10.1234/abc");
  });

  it("strips a http:// dx.doi.org prefix", () => {
    expect(normalizeDoi("http://dx.doi.org/10.1234/AbC")).toBe("10.1234/abc");
  });

  it("strips a leading doi: tag", () => {
    expect(normalizeDoi("doi:10.1234/AbC")).toBe("10.1234/abc");
  });

  it("trims whitespace and lowercases", () => {
    expect(normalizeDoi("  10.1234/ABC  ")).toBe("10.1234/abc");
  });
});

describe("shortOpenAlexId", () => {
  it("extracts the short id from a full openalex URL", () => {
    expect(shortOpenAlexId("https://openalex.org/W2741809807")).toBe(
      "W2741809807"
    );
  });

  it("passes through a bare id unchanged (uppercased)", () => {
    expect(shortOpenAlexId("w2741809807")).toBe("W2741809807");
  });

  it("handles trailing slashes/whitespace gracefully", () => {
    expect(shortOpenAlexId("  https://openalex.org/W123  ")).toBe("W123");
  });
});

describe("toPaper", () => {
  it("returns null when the work has no title", () => {
    const work: OpenAlexWork = {
      id: "https://openalex.org/W1",
    };
    expect(toPaper(work)).toBeNull();
  });

  it("returns null when the work has no id", () => {
    const work: OpenAlexWork = {
      display_name: "A paper with no id",
    };
    expect(toPaper(work)).toBeNull();
  });

  it("builds a canonical doi: id and an oa: alias when a DOI is present", () => {
    const work: OpenAlexWork = {
      id: "https://openalex.org/W2741809807",
      doi: "https://doi.org/10.1234/AbC",
      display_name: "Some Title",
      publication_year: 2020,
      cited_by_count: 42,
      authorships: [
        { author: { display_name: "Ada Lovelace" } },
        { author: { display_name: "Alan Turing" } },
      ],
      primary_location: { source: { display_name: "Journal of Testing" } },
      topics: [{ display_name: "Computer Science" }],
      referenced_works: ["https://openalex.org/W1", "https://openalex.org/W2"],
    };

    const paper = toPaper(work);
    expect(paper).not.toBeNull();
    expect(paper!.id).toBe("doi:10.1234/abc");
    expect(paper!.aliases).toContain("oa:W2741809807");
    expect(paper!.aliases).not.toContain("doi:10.1234/abc");
    expect(paper!.title).toBe("Some Title");
    expect(paper!.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect(paper!.venue).toBe("Journal of Testing");
    expect(paper!.year).toBe(2020);
    expect(paper!.citedByCount).toBe(42);
    expect(paper!.keywords).toEqual(["Computer Science"]);
    expect(paper!.source).toBe("openalex");
    expect(paper!.doi).toBe("10.1234/abc");
  });

  it("falls back to an oa: canonical id when there is no DOI, with no aliases duplicate", () => {
    const work: OpenAlexWork = {
      id: "https://openalex.org/W999",
      display_name: "No DOI Here",
    };

    const paper = toPaper(work);
    expect(paper).not.toBeNull();
    expect(paper!.id).toBe("oa:W999");
    // the canonical id itself should not also appear in aliases
    expect(paper!.aliases ?? []).not.toContain("oa:W999");
    expect(paper!.doi).toBeUndefined();
  });

  it("maps referenced_works to oa: prefixed ids", () => {
    const work: OpenAlexWork = {
      id: "https://openalex.org/W1",
      display_name: "Has references",
      referenced_works: [
        "https://openalex.org/W2",
        "https://openalex.org/W3",
      ],
    };

    const paper = toPaper(work);
    expect(paper).not.toBeNull();
    expect(paper!.references).toEqual(["oa:W2", "oa:W3"]);
  });

  it("defaults missing fields to safe values", () => {
    const work: OpenAlexWork = {
      id: "https://openalex.org/W5",
      display_name: "Sparse work",
    };

    const paper = toPaper(work);
    expect(paper).not.toBeNull();
    expect(paper!.year).toBe(0);
    expect(paper!.citedByCount).toBe(0);
    expect(paper!.authors).toEqual([]);
    expect(paper!.venue).toBe("");
    expect(paper!.abstract).toBe("");
    expect(paper!.references).toEqual([]);
  });

  it("falls back to concepts for keywords when topics are absent", () => {
    const work: OpenAlexWork = {
      id: "https://openalex.org/W6",
      display_name: "Concept fallback",
      concepts: [{ display_name: "Biology" }, { display_name: "Genetics" }],
    };

    const paper = toPaper(work);
    expect(paper).not.toBeNull();
    expect(paper!.keywords).toEqual(["Biology", "Genetics"]);
  });
});

describe("fetchPaperMetadata", () => {
  it("is a function that exists", () => {
    expect(typeof fetchPaperMetadata).toBe("function");
  });
});
