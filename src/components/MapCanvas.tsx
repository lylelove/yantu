import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Paper, PaperId, PaperProgress, Visibility } from "../game/types";
import { advanceLayout, createLayout, layoutBounds, recomputeRegionCentres, type Layout } from "../render/layout";
import { draw, hitTest, screenToWorld, type Camera, type DrawState } from "../render/draw";
import { useStore } from "../state/store";
import type { Theme } from "../theme";
import TimelineOverlay from "./TimelineOverlay";

/**
 * The map surface.
 *
 * This component owns exactly two things: the camera (pan/zoom) and the
 * animation loop. Layout lives in `render/layout`, painting in `render/draw`,
 * and the world itself in the store — so what happens here is only ever
 * "translate input into camera changes, then ask draw() for a frame".
 *
 * The canvas is deliberately not React-rendered per node. At a thousand-plus
 * papers, one DOM element per node makes panning stutter; a single canvas keeps
 * interaction smooth and lets the fog be drawn as actual light.
 */

const MIN_SCALE = 0.18;
const MAX_SCALE = 3.2;
/** Pointer movement under this is a click, not a drag. */
const CLICK_SLOP = 4;
/**
 * Per-frame time budget for settling the layout, in milliseconds.
 *
 * A 60fps frame is ~16ms, so this spends roughly a third of it on physics and
 * leaves the rest for painting and input. Small maps settle within a few frames
 * regardless; large ones take a moment longer but never drop the frame rate.
 */
const LAYOUT_BUDGET_MS = 5;

export default function MapCanvas({
  children,
  theme,
}: {
  children?: React.ReactNode;
  theme: Theme;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const world = useStore((s) => s.world);
  const selectedId = useStore((s) => s.selectedId);
  const hoveredId = useStore((s) => s.hoveredId);
  const edgeFilter = useStore((s) => s.edgeFilter);
  const focusRegion = useStore((s) => s.focusRegion);
  const search = useStore((s) => s.search);
  const playbackTime = useStore((s) => s.playbackTime);
  const select = useStore((s) => s.select);
  const hover = useStore((s) => s.hover);

  const [size, setSize] = useState({ w: 800, h: 600 });
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  /** Bumped to force a redraw when nothing in props changed but the view did. */
  const [, setTick] = useState(0);

  /**
   * Structural fingerprint of the map's geometry.
   *
   * `buildWorld` is pure and returns fresh arrays on every commit, so keying the
   * layout on array identity would re-run the force simulation every time the
   * user marks something read — hundreds of iterations over the whole corpus,
   * in response to a single click. Positions depend only on which papers exist
   * and how they are connected, so that is what we key on instead: reading a
   * paper changes its colour, not its place on the map.
   */
  const structureKey = useMemo(() => {
    const regionsFingerprint = world.regions.map((r) => `${r.id}:${r.members.length}`).join(",");
    return `${world.papers.length}|${world.edges.length}|${regionsFingerprint}`;
  }, [world.papers, world.edges, world.regions]);

  // --- Layout. Warm-started from the previous layout so the map keeps its
  // shape when papers are added rather than reshuffling under the user. ---
  const layoutRef = useRef<Layout | null>(null);
  const layout = useMemo(() => {
    // Seeded only — the physics runs a few steps per frame in the animation
    // loop below. Settling a thousand papers takes seconds, and doing it here
    // would freeze the window on load and after every import.
    const next = createLayout(world.papers, world.edges, world.regions, {
      width: 1700,
      height: 1100,
      previous: layoutRef.current,
    });
    layoutRef.current = next;
    return next;
    // Deliberately keyed on the structural fingerprint rather than the arrays
    // themselves; see `structureKey` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  const paperMap = useMemo(() => {
    const m = new Map<PaperId, Paper>();
    for (const p of world.papers) m.set(p.id, p);
    return m;
  }, [world.papers]);

  const enteredRegions = useMemo(() => {
    const s = new Set<string>();
    for (const r of world.regionStatus) if (r.lit > 0) s.add(r.region.id);
    return s;
  }, [world.regionStatus]);

  /** Search matches. Empty set means "no search", which dims nothing. */
  const highlighted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = new Set<PaperId>();
    if (!q) return out;
    for (const p of world.papers) {
      // Never surface a paper still in fog: search must not leak the unknown.
      if ((world.visibility[p.id] ?? "fog") === "fog") continue;
      const haystack = `${p.title} ${p.authors.join(" ")} ${p.venue} ${p.keywords.join(" ")}`;
      if (haystack.toLowerCase().includes(q)) out.add(p.id);
    }
    return out;
  }, [search, world.papers, world.visibility]);

  // --- Size tracking. ---
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ w: Math.max(320, box.width), h: Math.max(240, box.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Frame the whole map. Used on first load and by the reset control. */
  const fitToView = useCallback(() => {
    const b = layoutBounds(layout);
    const pad = 70;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / h)),
    );
    cameraRef.current = {
      scale,
      x: b.minX + w / 2 - size.w / 2 / scale,
      y: b.minY + h / 2 - size.h / 2 / scale,
    };
    setTick((t) => t + 1);
  }, [layout, size.w, size.h]);

  // Fit once, as soon as there is something to look at. Deliberately not on
  // every layout change: yanking the camera while someone is reading is rude.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || layout.nodes.size === 0) return;
    fittedRef.current = true;
    // Frames the seed scatter, which is roughly right because region centres
    // are already final. The loop re-fits once the physics settles.
    fitToView();
  }, [layout, fitToView]);

  /**
   * Whether the user has taken the camera into their own hands. Once they have,
   * the post-settle re-fit is abandoned — moving someone's view out from under
   * them is worse than leaving the map slightly badly framed.
   */
  const userMovedRef = useRef(false);
  const refittedRef = useRef(false);

  /** Centre the camera on a paper, keeping the current zoom. */
  const centreOn = useCallback(
    (id: PaperId) => {
      const node = layout.nodes.get(id);
      if (!node) return;
      const cam = cameraRef.current;
      cameraRef.current = {
        ...cam,
        x: node.x - size.w / 2 / cam.scale,
        y: node.y - size.h / 2 / cam.scale,
      };
      setTick((t) => t + 1);
    },
    [layout, size.w, size.h],
  );

  // Follow the selection when it changes from outside the map (a lead click,
  // a search result) — but not when the user just clicked a node themselves,
  // which would yank the view out from under their cursor.
  const lastSelectionRef = useRef<PaperId | null>(null);
  const selfSelectedRef = useRef(false);
  useEffect(() => {
    if (selectedId && selectedId !== lastSelectionRef.current && !selfSelectedRef.current) {
      centreOn(selectedId);
    }
    selfSelectedRef.current = false;
    lastSelectionRef.current = selectedId;
  }, [selectedId, centreOn]);

  // --- Animation loop. Runs continuously so beacons can breathe. ---
  const timeRef = useRef(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;

    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      timeRef.current += (now - last) / 1000;
      last = now;

      // Settle the layout a little at a time, under a wall-clock budget rather
      // than a fixed step count: one iteration over a thousand papers costs far
      // more than over fifty, and the budget is what actually protects the
      // frame rate. The map visibly drifts into shape and stays interactive.

      // --- Drag mode: per-frame physics for visible collision animation.
      // While the user is actively dragging, we run ~6 iterations per frame
      // so even heavy (large-radius, well-connected) nodes accumulate enough
      // displacement to visibly ease aside.  After the drag ends (node stays
      // pinned but dragActiveRef is false), the normal settle loop finishes.
      if (dragActiveRef.current) {
        layout.settled = false;
        layout.target = Math.max(layout.target, layout.iterations + 6);
        advanceLayout(layout, 6);
        layout.settled = false;
      } else if (!layout.settled) {
        const until = performance.now() + LAYOUT_BUDGET_MS;
        do {
          advanceLayout(layout, 1);
        } while (!layout.settled && performance.now() < until);

        // Once it stops moving, frame it properly — the seed-time fit was
        // against the initial scatter. Skipped if the user has already taken
        // the camera somewhere themselves.
        if (layout.settled && !refittedRef.current && !userMovedRef.current) {
          refittedRef.current = true;
          fitToView();
        }
      }

      // Update region territory circles to follow their member nodes.
      // Only the drawn wash moves — node anchors stay fixed so no clustering.
      recomputeRegionCentres(layout.nodes, world.regions, layout.regionCentres);

      // If playbackTime is set, filter visibility to only show papers
      // that were lit at or before that time.
      const playbackFiltered = playbackTime
        ? filterVisibilityByTime(world.visibility, world.progress, playbackTime)
        : world.visibility;

      const state: DrawState = {
        layout,
        theme,
        papers: paperMap,
        edges: world.edges,
        regions: world.regions,
        visibility: playbackFiltered,
        enteredRegions,
        camera: cameraRef.current,
        selectedId,
        hoveredId,
        highlighted,
        edgeFilter,
        focusRegion,
        time: timeRef.current,
        dpr,
      };
      draw(ctx, state, size.w, size.h);
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [
    layout,
    theme,
    paperMap,
    world.edges,
    world.regions,
    world.visibility,
    enteredRegions,
    selectedId,
    hoveredId,
    highlighted,
    edgeFilter,
    focusRegion,
    size,
    // Listed because the loop calls it on settle. Its own deps (layout, size)
    // are already here, so this does not restart the loop any more often.
    fitToView,
  ]);

  // --- Pointer interaction: drag node, drag to pan, click to select. ---
  const dragRef = useRef<{
    sx: number;
    sy: number;
    camX: number;
    camY: number;
    moved: number;
    /** Set when the pointer went down on a node — we are dragging that node. */
    nodeId: PaperId | null;
  } | null>(null);

  /**
   * Whether a pan is actually underway. Separate from `dragRef` because this
   * drives the cursor and so must live in state, and it only becomes true once
   * the pointer has moved past the click threshold — otherwise every plain
   * click would flash the grabbing cursor.
   */
  const [panning, setPanning] = useState(false);
  /** True while the user is actively dragging a node (affects cursor + layout). */
  const [draggingNode, setDraggingNode] = useState(false);
  /** Ref version so the animation-loop closure can read it without deps. */
  const dragActiveRef = useRef(false);

  const localPoint = (e: React.PointerEvent | React.WheelEvent): [number, number] => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const [sx, sy] = localPoint(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    // Check if the pointer is on a visible node → node drag mode.
    const state = hitState();
    const hitId = state ? hitTest(state, sx, sy) : null;

    dragRef.current = {
      sx,
      sy,
      camX: cameraRef.current.x,
      camY: cameraRef.current.y,
      moved: 0,
      nodeId: hitId,
    };

    if (hitId) {
      // Pin this node so the simulation does not fight the user.
      // Unpin all previously pinned nodes first, so old dragged nodes can
      // participate in future collisions again.
      for (const n of layout.nodes.values()) {
        if (n.id !== hitId) n.pinned = false;
      }
      const node = layout.nodes.get(hitId);
      if (node) {
        node.pinned = true;
        // Re-activate layout physics so other nodes are pushed by collision.
        layout.settled = false;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = localPoint(e);
    const drag = dragRef.current;

    if (drag) {
      const dx = sx - drag.sx;
      const dy = sy - drag.sy;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));

      if (drag.nodeId) {
        if (drag.moved > CLICK_SLOP) {
          if (!draggingNode) {
            setDraggingNode(true);
            dragActiveRef.current = true;
          }
          userMovedRef.current = true;
          const node = layout.nodes.get(drag.nodeId);
          if (node) {
            const scale = cameraRef.current.scale;
            node.x += dx / scale;
            node.y += dy / scale;
            drag.sx = sx;
            drag.sy = sy;
            layout.settled = false;
          }
        }
        setTick((t) => t + 1);
        return;
      }

      // --- Canvas panning. ---
      if (drag.moved > CLICK_SLOP) {
        if (!panning) setPanning(true);
        userMovedRef.current = true;
      }
      const scale = cameraRef.current.scale;
      cameraRef.current = {
        ...cameraRef.current,
        x: drag.camX - dx / scale,
        y: drag.camY - dy / scale,
      };
      setTick((t) => t + 1);
      return;
    }

    // Hover feedback only when not dragging.
    const state = hitState();
    const id = state ? hitTest(state, sx, sy) : null;
    if (id !== hoveredId) hover(id);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (!drag) return;

    if (drag.nodeId) {
      const wasDragged = drag.moved > CLICK_SLOP;
      setDraggingNode(false);
      dragActiveRef.current = false;
      if (wasDragged) {
        // Node stays pinned at its final position. Give neighbours ~20
        // iterations to settle back before the layout stops.
        layout.settled = false;
        layout.target = Math.max(layout.target, layout.iterations + 20);
      } else {
        // Click on a node (no meaningful movement): unpin and select.
        const node = layout.nodes.get(drag.nodeId);
        if (node) node.pinned = false;
        selfSelectedRef.current = true;
        select(drag.nodeId);
      }
      return;
    }

    if (drag.moved > CLICK_SLOP) return; // a pan, not a click

    const [sx, sy] = localPoint(e);
    const state = hitState();
    const id = state ? hitTest(state, sx, sy) : null;
    selfSelectedRef.current = true;
    select(id);
  };

  /**
   * Current DrawState, for hit-testing against the live camera. Only the
   * geometry fields matter here, but hitTest takes the whole state so the
   * hit target can never drift from what was actually painted.
   */
  const hitState = (): DrawState | null => {
    if (!layout) return null;
    return {
      layout,
      theme,
      papers: paperMap,
      edges: world.edges,
      regions: world.regions,
      visibility: world.visibility,
      enteredRegions,
      camera: cameraRef.current,
      selectedId,
      hoveredId,
      highlighted,
      edgeFilter,
      focusRegion,
      time: timeRef.current,
      dpr: 1,
    };
  };

  /** Zoom toward the cursor, so the point under the pointer stays put.
   *  Attached via native addEventListener with { passive: false } so
   *  preventDefault works (React uses passive listeners for wheel). */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const cam = cameraRef.current;
      const [wx, wy] = screenToWorld(cam, sx, sy);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cam.scale * factor));
      cameraRef.current = { scale, x: wx - sx / scale, y: wy - sy / scale };
      userMovedRef.current = true;
      setTick((t) => t + 1);
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, []);

  const zoomBy = (factor: number) => {
    const cam = cameraRef.current;
    const [wx, wy] = screenToWorld(cam, size.w / 2, size.h / 2);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cam.scale * factor));
    cameraRef.current = { scale, x: wx - size.w / 2 / scale, y: wy - size.h / 2 / scale };
    userMovedRef.current = true;
    setTick((t) => t + 1);
  };

  // Keyboard access to the same operations, for users who cannot drag.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const cam = cameraRef.current;
    const step = 90 / cam.scale;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      cameraRef.current = { ...cam, x: cam.x + dx, y: cam.y + dy };
      userMovedRef.current = true;
      setTick((t) => t + 1);
      return;
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(1.2);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomBy(1 / 1.2);
    } else if (e.key === "0") {
      e.preventDefault();
      fitToView();
    } else if (e.key === "Escape") {
      select(null);
    }
  };

  const empty = world.papers.length === 0;

  return (
    <div className="map-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="map-canvas"
        role="application"
        tabIndex={0}
        aria-label="学术地图。使用方向键平移，加号和减号缩放，0 键回到全景。"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => hover(null)}
        onKeyDown={onKeyDown}
        // `panning` is state rather than the drag ref: a ref read during
        // render never triggers one, so the grab cursor would never change.
        style={{ cursor: draggingNode ? "grabbing" : hoveredId ? "pointer" : panning ? "grabbing" : "grab" }}
      />

      {empty && (
        <div className="map-empty">
          <p>地图还是一片空白。</p>
          <p className="map-empty-hint">导入文献，或载入示例地图开始探索。</p>
        </div>
      )}

      {/* Overlays live inside the map wrapper so they position against the map
          itself rather than the viewport — which also keeps them off the
          sidebar when it stacks underneath on a narrow window. */}
      {children}

      <TimelineOverlay />

      <div className="map-controls" role="group" aria-label="地图视图控制">
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="放大">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="缩小">
          −
        </button>
        <button type="button" onClick={fitToView} aria-label="回到全景">
          ⤢
        </button>
      </div>
    </div>
  );
}

/**
 * Filter visibility to only show papers lit at or before a given timestamp.
 */
function filterVisibilityByTime(
  visibility: Record<string, Visibility>,
  progress: Record<string, PaperProgress>,
  cutoff: string,
): Record<string, Visibility> {
  const result: Record<string, Visibility> = {};
  for (const [id, v] of Object.entries(visibility)) {
    const pr = progress[id];
    if (pr?.litAt && pr.litAt <= cutoff) {
      result[id] = v;
    } else {
      // Keep imported/seed papers (they are always at least frontier)
      if (v === "fog" || v === "sensed") {
        result[id] = v;
      } else {
        // Convert lit/beacon/frontier back to sensed if not yet lit by cutoff
        result[id] = "sensed";
      }
    }
  }
  return result;
}

