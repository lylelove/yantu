import type { PaperId, SaveState } from "../game/types";
import { emptySave } from "../game/world";
import { SEED_LIBRARY_IDS, SEED_PAPERS } from "./seed";

/**
 * The sample map offered on first run.
 *
 * A brand-new save would technically work, but it would open on eight unread
 * outlines and nothing else — the fog mechanic would be invisible, and the user
 * would have no way to tell that reading is what reveals the map.
 *
 * So the sample starts mid-exploration: a few papers already read, one of them
 * annotated. That way the first frame already shows the whole vocabulary at
 * once — lit nodes glowing, a beacon reaching further, frontier papers waiting
 * at the edge, and dim shapes beyond them.
 */

/** How many of the starting library begin as read. */
const PRE_READ = 3;

export function createSampleSave(): SaveState {
  const base = emptySave();
  const papers = Object.fromEntries(SEED_PAPERS.map((p) => [p.id, p]));

  const now = new Date().toISOString();
  const progress: SaveState["progress"] = {};

  // Read the first few of the owned library, so light is already spreading.
  const preRead: PaperId[] = SEED_LIBRARY_IDS.slice(0, PRE_READ);
  preRead.forEach((id, i) => {
    progress[id] = {
      state: "read",
      // One of them carries a note, which makes it a beacon: the user can see
      // straight away that writing something down reaches further.
      note:
        i === 0
          ? "示例笔记：写下想法后，这篇会成为灯塔，比普通「已读」多照亮一跳。"
          : "",
      firstSeenAt: now,
      litAt: now,
    };
  });

  return { ...base, papers, progress };
}
