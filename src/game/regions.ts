import type { Paper, PaperId, Region, RegionId } from "./types";

/**
 * Region discovery — carving the corpus into named territories.
 *
 * We deliberately use a greedy keyword-seed method rather than a black-box
 * clustering algorithm: every region can state the term it was named for, and
 * the same corpus always produces the same regions. Explainability and
 * stability matter more here than cluster purity, because these names are how
 * the user reasons about their own blind spots.
 */

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Stable hue from a string, so a region keeps its colour across sessions. */
function hueOf(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/** Prefer the most common surface form of a keyword for display. */
function pickLabel(forms: Map<string, number>): string {
  let best = "";
  let bestN = -1;
  for (const [form, n] of forms) {
    if (n > bestN || (n === bestN && form.length < best.length)) {
      best = form;
      bestN = n;
    }
  }
  return best;
}

export const UNSORTED_REGION: RegionId = "region:unsorted";

export interface RegionOptions {
  /** Upper bound on named regions; the tail is folded into "未归类". */
  maxRegions?: number;
  /** A keyword must cover at least this many papers to seed a region. */
  minMembers?: number;
}

/**
 * Assign every paper to exactly one region.
 *
 * Greedy: repeatedly take the keyword covering the most still-unassigned
 * papers, make it a region, and claim those papers. Ties break on the
 * alphabetically first term so results are deterministic.
 */
export function deriveRegions(papers: Paper[], opts: RegionOptions = {}): Region[] {
  const maxRegions = opts.maxRegions ?? 14;
  const minMembers = opts.minMembers ?? 2;

  // keyword -> papers, plus the surface forms seen for display.
  const byKeyword = new Map<string, Set<PaperId>>();
  const forms = new Map<string, Map<string, number>>();
  for (const p of papers) {
    for (const raw of p.keywords) {
      const k = norm(raw);
      if (!k) continue;
      let set = byKeyword.get(k);
      if (!set) byKeyword.set(k, (set = new Set()));
      set.add(p.id);
      let f = forms.get(k);
      if (!f) forms.set(k, (f = new Map()));
      f.set(raw.trim(), (f.get(raw.trim()) ?? 0) + 1);
    }
  }

  const unassigned = new Set<PaperId>(papers.map((p) => p.id));
  const regions: Region[] = [];

  while (regions.length < maxRegions && unassigned.size > 0) {
    let bestKey = "";
    let bestGain: PaperId[] = [];
    for (const [k, ids] of byKeyword) {
      let gain: PaperId[] | null = null;
      for (const id of ids) {
        if (!unassigned.has(id)) continue;
        (gain ??= []).push(id);
      }
      if (!gain) continue;
      if (
        gain.length > bestGain.length ||
        (gain.length === bestGain.length && bestKey !== "" && k < bestKey)
      ) {
        bestKey = k;
        bestGain = gain;
      }
    }
    if (!bestKey || bestGain.length < minMembers) break;

    for (const id of bestGain) unassigned.delete(id);
    const label = pickLabel(forms.get(bestKey)!);
    // Characteristic terms: what else these papers talk about.
    const co = new Map<string, number>();
    const memberSet = new Set(bestGain);
    for (const p of papers) {
      if (!memberSet.has(p.id)) continue;
      for (const raw of p.keywords) {
        const k = norm(raw);
        if (!k || k === bestKey) continue;
        co.set(k, (co.get(k) ?? 0) + 1);
      }
    }
    const keywords = [label, ...[...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)];

    regions.push({
      id: `region:${bestKey}`,
      name: label,
      keywords,
      members: bestGain.sort(),
      hue: hueOf(bestKey),
    });
  }

  if (unassigned.size > 0) {
    regions.push({
      id: UNSORTED_REGION,
      name: "未归类",
      keywords: [],
      members: [...unassigned].sort(),
      hue: 220,
    });
  }

  return regions;
}

/** Reverse index: paper -> its region. */
export function regionIndex(regions: Region[]): Map<PaperId, Region> {
  const idx = new Map<PaperId, Region>();
  for (const r of regions) for (const id of r.members) idx.set(id, r);
  return idx;
}
