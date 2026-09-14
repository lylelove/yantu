import { describe, expect, it } from "vitest";

import { parseBibliography } from "./import";

describe("parseBibliography", () => {
  it("parses BibTeX and normalises DOI identity", () => {
    const result = parseBibliography(
      '@article{smith2024,\n  title = {A {Useful} Paper},\n  author = {Smith, Jane and Doe, John},\n  year = {2024},\n  journal = {Journal of Tests},\n  doi = {10.1234/ABC}\n}',
      "library.bib",
    );

    expect(result.parsed).toBe(1);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toMatchObject({
      id: "doi:10.1234/abc",
      title: "A Useful Paper",
      authors: ["Jane Smith", "John Doe"],
      year: 2024,
      venue: "Journal of Tests",
    });
  });

  it("parses RIS records and keeps repeated authors and keywords", () => {
    const result = parseBibliography(
      [
        "TY  - JOUR",
        "TI  - A RIS paper",
        "AU  - Ada Lovelace",
        "AU  - Alan Turing",
        "PY  - 2023",
        "JO  - Computing Review",
        "KW  - graphs",
        "KW  - causal inference",
        "ER  -",
      ].join("\n"),
      "export.ris",
    );

    expect(result.parsed).toBe(1);
    expect(result.papers[0]).toMatchObject({
      title: "A RIS paper",
      authors: ["Ada Lovelace", "Alan Turing"],
      keywords: ["graphs", "causal inference"],
      year: 2023,
    });
  });

  it("parses quoted CSV fields without splitting their commas", () => {
    const result = parseBibliography(
      [
        "title,author,abstract,year,publicationTitle",
        '"A paper, with commas","Doe, Jane","A short, useful abstract",2022,"Test Journal"',
      ].join("\n"),
      "zotero.csv",
    );

    expect(result.papers[0]).toMatchObject({
      title: "A paper, with commas",
      authors: ["Jane Doe"],
      abstract: "A short, useful abstract",
      venue: "Test Journal",
    });
  });

  it("accepts CSL JSON author and date shapes, and reports duplicates", () => {
    const record = {
      title: "CSL work",
      author: [{ given: "Ada", family: "Lovelace" }],
      issued: { "date-parts": [[2021]] },
      DOI: "https://doi.org/10.1234/csl",
    };
    const result = parseBibliography(JSON.stringify([record, record]), "items.json");

    expect(result.parsed).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.papers[0]).toMatchObject({
      id: "doi:10.1234/csl",
      authors: ["Ada Lovelace"],
      year: 2021,
    });
  });

  it("returns a readable issue for empty or unrecognised input", () => {
    expect(parseBibliography("", "empty.txt").issues[0].message).toContain("为空");
    expect(parseBibliography("hello world", "notes.txt").issues[0].message).toContain("无法识别");
  });

  it("supports BibTeX string macros, concatenated values, comments, and parenthesis entries", () => {
    const result = parseBibliography(
      String.raw`% exported from a reference manager
@string{jmlr = "Journal of Machine Learning Research"}
@comment{this is metadata, not a paper}
@preamble{"ignored"}
@article(key2024,
  title = {A {Robust} Study},
  author = {Doe, Jr, Jane and {World Health Organization}},
  date = {2024-06},
  journaltitle = jmlr # " (Online)",
  keywords = {graph learning, causal inference},
  url = {\url{https://example.org/paper}},
  doi = {10.1234/ABC}
)`,
      "references.BIB",
    );

    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.papers[0]).toMatchObject({
      id: "doi:10.1234/abc",
      title: "A Robust Study",
      authors: ["Jane Doe Jr", "World Health Organization"],
      year: 2024,
      venue: "Journal of Machine Learning Research (Online)",
      keywords: ["graph learning", "causal inference"],
      url: "https://example.org/paper",
    });
  });

  it("skips BibTeX entries without a title while importing valid entries", () => {
    const result = parseBibliography(
      String.raw`@article{missing, author = {Nobody, Null}, year = {2020}}
@inproceedings{valid,
  title = {A Valid Entry},
  author = {Smith, Alice},
  year = 2020,
  booktitle = {Proceedings of Testing}
}`,
      "references.bib",
    );

    expect(result.parsed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toMatchObject({
      title: "A Valid Entry",
      authors: ["Alice Smith"],
      venue: "Proceedings of Testing",
    });
    expect(result.issues.some((issue) => issue.message.includes("缺少标题"))).toBe(true);
  });

});
