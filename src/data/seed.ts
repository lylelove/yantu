import type { Paper } from "../game/types";

/**
 * Small, self-contained corpus used by the first-run sample map. The five
 * `seed` records are the user's starting library; the remaining OpenAlex-shaped
 * records stand for papers that are already in the local demo corpus but stay
 * behind the fog until a seed paper points at them.
 */
export const SEED_LIBRARY_IDS = [
  "doi:10.5555/yantu.attention",
  "doi:10.5555/yantu.graphs",
  "doi:10.5555/yantu.causal",
  "doi:10.5555/yantu.representation",
  "doi:10.5555/yantu.interpretability",
] as const;

const seed = (
  id: string,
  title: string,
  keywords: string[],
  references: string[] = [],
  over: Partial<Paper> = {},
): Paper => ({
  id,
  title,
  authors: [],
  year: 2020,
  venue: "示例研究集",
  abstract: "",
  keywords,
  citedByCount: 0,
  references,
  source: "seed",
  ...over,
});

export const SEED_PAPERS: Paper[] = [
  seed(
    SEED_LIBRARY_IDS[0],
    "Attention Is All You Need",
    ["attention", "representation learning", "sequence modeling"],
    ["oa:W-yantu-graph", "oa:W-yantu-causal"],
    {
      authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
      year: 2017,
      venue: "NeurIPS",
      citedByCount: 120000,
    },
  ),
  seed(
    SEED_LIBRARY_IDS[1],
    "Graph Representation Learning",
    ["graphs", "representation learning", "graph neural networks"],
    ["oa:W-yantu-message", "oa:W-yantu-causal"],
    { authors: ["William L. Hamilton"], year: 2018, venue: "Synthesis Lectures" },
  ),
  seed(
    SEED_LIBRARY_IDS[2],
    "Causal Inference: A Review",
    ["causal inference", "graphs", "interpretability"],
    ["oa:W-yantu-causal-foundation"],
    { authors: ["Judea Pearl"], year: 2009, venue: "Foundations and Trends" },
  ),
  seed(
    SEED_LIBRARY_IDS[3],
    "A Practical View of Representation Learning",
    ["representation learning", "machine learning", "interpretability"],
    ["oa:W-yantu-disentangle"],
    { authors: ["Yoshua Bengio"], year: 2013, venue: "IEEE TPAMI" },
  ),
  seed(
    SEED_LIBRARY_IDS[4],
    "Interpretability Beyond Feature Importance",
    ["interpretability", "machine learning", "causal inference"],
    ["oa:W-yantu-disentangle", "oa:W-yantu-evaluation"],
    { authors: ["Marco Tulio Ribeiro"], year: 2021, venue: "ML Research" },
  ),
  seed(
    "oa:W-yantu-graph",
    "Message Passing on Relational Data",
    ["graphs", "graph neural networks", "representation learning"],
    ["oa:W-yantu-message"],
    { source: "openalex", year: 2019, venue: "ICLR", citedByCount: 3400 },
  ),
  seed(
    "oa:W-yantu-causal",
    "Learning Causal Structure from Observations",
    ["causal inference", "graphs", "machine learning"],
    ["oa:W-yantu-causal-foundation"],
    { source: "openalex", year: 2018, venue: "JMLR", citedByCount: 2100 },
  ),
  seed(
    "oa:W-yantu-message",
    "Neural Message Passing for Quantum Chemistry",
    ["graph neural networks", "representation learning", "scientific machine learning"],
    [],
    { source: "openalex", year: 2017, venue: "ICML", citedByCount: 5600 },
  ),
  seed(
    "oa:W-yantu-causal-foundation",
    "The Book of Why: Probabilistic Reasoning and Causal Inference",
    ["causal inference", "probabilistic reasoning", "interpretability"],
    [],
    { source: "openalex", year: 2018, venue: "Basic Books", citedByCount: 1800 },
  ),
  seed(
    "oa:W-yantu-disentangle",
    "Learning Disentangled Representations",
    ["representation learning", "interpretability", "machine learning"],
    ["oa:W-yantu-evaluation"],
    { source: "openalex", year: 2016, venue: "NeurIPS", citedByCount: 4200 },
  ),
  seed(
    "oa:W-yantu-evaluation",
    "Evaluating Explanations for Machine Learning Models",
    ["interpretability", "evaluation", "human-centered machine learning"],
    [],
    { source: "openalex", year: 2022, venue: "FAccT", citedByCount: 750 },
  ),
];
