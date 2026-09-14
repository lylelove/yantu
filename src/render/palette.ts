import type { EdgeKind, Visibility } from "../game/types";
import type { Theme } from "../theme";

/**
 * Visual language — light mode only.
 *
 * Yantu used to support a dark theme as well, but the app now uses only the
 * light palette. The colour system stays intact so region hue continues to
 * carry *where* a paper sits and brightness carries *how well you know it*.
 */

export const COLORS = {
  /** Near-white background, warm so region hues feel grounded. */
  void: "#edf3f8",
  voidSoft: "#f8fbfd",
  grid: "rgba(76, 104, 135, 0.12)",

  ink: "#17283b",
  inkMuted: "#52657c",
  inkFaint: "#7a8da3",

  /** The "you have read this" accent. Warm amber. */
  lit: "#b86a0a",
  litGlow: "rgba(224, 155, 44, 0.28)",

  /** Beacons: cooler teal, so they stand apart from plain lit nodes. */
  beacon: "#087e80",
  beaconGlow: "rgba(20, 157, 155, 0.24)",

  /** Frontier: identified, unread, actionable. */
  frontier: "#45678f",

  /** Sensed: something is there, no detail. */
  sensed: "#9aaabd",

  selection: "#193451",
  danger: "#b84a4a",
} as const;

export type Palette = { [K in keyof typeof COLORS]: string };

export function colorsFor(_theme: Theme): Palette {
  return COLORS;
}

/** Fill and stroke for a node at a given visibility. */
export function nodeStyle(v: Visibility, _theme: Theme = "light"): {
  fill: string;
  stroke: string;
  glow: string | null;
  /** 0..1 — drives label opacity too. */
  presence: number;
} {
  const colors = colorsFor(_theme);
  switch (v) {
    case "beacon":
      return { fill: colors.beacon, stroke: "#ffffff", glow: colors.beaconGlow, presence: 1 };
    case "lit":
      return { fill: colors.lit, stroke: "#fff1d5", glow: colors.litGlow, presence: 1 };
    case "frontier":
      return { fill: "rgba(255, 255, 255, 0.82)", stroke: colors.frontier, glow: null, presence: 0.82 };
    case "sensed":
      return { fill: "rgba(224, 232, 240, 0.72)", stroke: colors.sensed, glow: null, presence: 0.4 };
    case "fog":
      return { fill: "transparent", stroke: "transparent", glow: null, presence: 0 };
  }
}

/**
 * Line style per relation kind. Citations are the backbone of the map so they
 * get a solid line; everything inferred is dashed, which keeps "this is a fact"
 * visually distinct from "we computed this".
 */
export function edgeStyle(kind: EdgeKind): { dash: number[]; alpha: number; width: number } {
  switch (kind) {
    case "cites":
      return { dash: [], alpha: 0.5, width: 1.15 };
    case "manual":
      return { dash: [], alpha: 0.62, width: 1.5 };
    case "coauthor":
      return { dash: [5, 3], alpha: 0.34, width: 1 };
    case "keyword":
      return { dash: [2, 4], alpha: 0.26, width: 0.9 };
    case "venue":
      return { dash: [1, 5], alpha: 0.16, width: 0.75 };
  }
}

/** Human labels for relation kinds, used in the legend and filters. */
export const EDGE_LABELS: Record<EdgeKind, string> = {
  cites: "引用",
  coauthor: "同作者",
  keyword: "主题相近",
  venue: "同期刊",
  manual: "手动关联",
};

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  beacon: "灯塔",
  lit: "已点亮",
  frontier: "视野边缘",
  sensed: "隐约可见",
  fog: "未知",
};

/** Region wash. Kept very low alpha: territory should suggest, not shout. */
export function regionFill(hue: number, entered: boolean, _theme: Theme = "light"): string {
  return entered
    ? `hsla(${hue}, 62%, 48%, 0.12)`
    : `hsla(${hue}, 38%, 48%, 0.07)`;
}

export function regionStroke(hue: number, entered: boolean, _theme: Theme = "light"): string {
  return entered
    ? `hsla(${hue}, 58%, 42%, 0.32)`
    : `hsla(${hue}, 32%, 42%, 0.22)`;
}

export function regionLabel(hue: number, entered: boolean, _theme: Theme = "light"): string {
  return entered
    ? `hsla(${hue}, 58%, 32%, 0.86)`
    : `hsla(${hue}, 32%, 35%, 0.62)`;
}

/** Tint a node by its region so territory survives at a glance. */
export function regionTint(hue: number, v: Visibility, _theme: Theme = "light"): string {
  if (v === "lit") return `hsl(${hue}, 72%, 45%)`;
  if (v === "beacon") return `hsl(${hue}, 68%, 39%)`;
  return nodeStyle(v, _theme).stroke;
}
