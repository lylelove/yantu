import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SaveState } from "../game/types";
import { emptySave } from "../game/world";
import {
  clearSave,
  exportSave,
  flushSave,
  importSave,
  loadSave,
  scheduleSave,
  writeSaveNow,
} from "./storage";

/**
 * The tests run in a node environment, so `localStorage` has to be supplied.
 * A real Map-backed stand-in (rather than a mock returning canned values) means
 * these tests exercise the actual round trip, including JSON serialisation.
 */
class MemoryStorage {
  private data = new Map<string, string>();
  /** Set to simulate a quota failure. */
  failWrites = false;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  get size(): number {
    return this.data.size;
  }
  /** Plant arbitrary text, to test how corrupt data is handled. */
  poison(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const KEY = "yantu.save.v1";
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  // Silence the deliberate warnings these tests provoke.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function saveWith(papers: SaveState["papers"] = {}): SaveState {
  return { ...emptySave(), papers };
}

describe("loadSave", () => {
  it("returns null when nothing has been stored", () => {
    expect(loadSave()).toBeNull();
  });

  it("round-trips a save", () => {
    const save = saveWith({
      "doi:10.1/a": {
        id: "doi:10.1/a",
        title: "A",
        authors: ["X"],
        year: 2020,
        venue: "V",
        abstract: "",
        keywords: ["k"],
        citedByCount: 3,
        references: [],
        source: "import",
      },
    });
    writeSaveNow(save);

    const loaded = loadSave();
    expect(loaded?.papers["doi:10.1/a"].title).toBe("A");
  });

  it("ignores unparseable data instead of throwing", () => {
    // Losing the app entirely because one key went bad is worse than a reset.
    storage.poison(KEY, "{not json");
    expect(loadSave()).toBeNull();
  });

  it("rejects JSON that is not a save file", () => {
    storage.poison(KEY, JSON.stringify({ hello: "world" }));
    expect(loadSave()).toBeNull();
  });

  it("rejects a save from an unknown version", () => {
    storage.poison(KEY, JSON.stringify({ ...emptySave(), version: 99 }));
    expect(loadSave()).toBeNull();
  });

  it("repairs a save with missing collections rather than discarding it", () => {
    // A partial write should cost the broken field, not the whole library.
    storage.poison(
      KEY,
      JSON.stringify({ version: 1, papers: {}, progress: {}, manualEdges: [] }),
    );
    const loaded = loadSave();
    expect(loaded).not.toBeNull();
    expect(loaded!.regionNames).toEqual({});
    expect(loaded!.createdAt).toBeTruthy();
  });

  it("survives storage being unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("SecurityError: storage disabled");
      },
    });
    expect(loadSave()).toBeNull();
  });
});

describe("writeSaveNow", () => {
  it("reports success and failure honestly", () => {
    expect(writeSaveNow(saveWith())).toBe(true);
    storage.failWrites = true;
    // Silent data loss is the one failure a user cannot recover from, so the
    // return value has to distinguish a failed write from a successful one.
    expect(writeSaveNow(saveWith())).toBe(false);
  });

  it("stamps updatedAt on every write", () => {
    const save = { ...emptySave(), updatedAt: "1999-01-01T00:00:00.000Z" };
    writeSaveNow(save);
    expect(loadSave()!.updatedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });
});

describe("scheduleSave", () => {
  it("collapses repeated calls into a single write", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(storage, "setItem");

    scheduleSave(saveWith());
    scheduleSave(saveWith());
    scheduleSave(saveWith());
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("flushes a queued write immediately", () => {
    vi.useFakeTimers();
    scheduleSave(saveWith());
    flushSave(saveWith());
    // Already written by the flush; the pending timer must not fire again.
    const spy = vi.spyOn(storage, "setItem");
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
    expect(loadSave()).not.toBeNull();
  });
});

describe("clearSave", () => {
  it("removes the stored save", () => {
    writeSaveNow(saveWith());
    clearSave();
    expect(loadSave()).toBeNull();
  });
});

describe("exportSave / importSave", () => {
  it("round-trips through the exported text", () => {
    const save = saveWith({
      "local:x": {
        id: "local:x",
        title: "Exported",
        authors: [],
        year: 2021,
        venue: "",
        abstract: "",
        keywords: [],
        citedByCount: 0,
        references: [],
        source: "import",
      },
    });
    const restored = importSave(exportSave(save));
    expect(restored.papers["local:x"].title).toBe("Exported");
  });

  it("explains what went wrong in the user's language", () => {
    expect(() => importSave("nonsense")).toThrow(/JSON/);
    expect(() => importSave(JSON.stringify({ a: 1 }))).toThrow(/Yantu/);
  });
});
