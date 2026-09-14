import { useMemo, useRef, useState } from "react";

import ExpeditionsPanel from "./components/ExpeditionsPanel";
import Hud from "./components/Hud";
import ImportSheet from "./components/ImportSheet";
import LeadsPanel from "./components/LeadsPanel";
import ManagementSheet from "./components/ManagementSheet";
import MapCanvas from "./components/MapCanvas";
import MapLegend from "./components/MapLegend";
import NotesSheet from "./components/NotesSheet";
import PaperPanel from "./components/PaperPanel";
import RegionsPanel from "./components/RegionsPanel";
import SaveSlotSheet from "./components/SaveSlotSheet";
import SettingsSheet from "./components/SettingsSheet";
import Toast from "./components/Toast";
import type { PaperId } from "./game/types";
import { createSampleSave } from "./data/sample";
import { exportSave } from "./state/storage";
import { useStore, type Panel } from "./state/store";
import { THEME } from "./theme";

/**
 * Application shell.
 *
 * Layout is a deliberate hierarchy: the map takes all the room it can get, and
 * every panel is subordinate to it. The tabs answer the three questions the app
 * exists to answer — where next, what should I attempt, and what am I not
 * looking at — with the selected paper as a fourth, contextual tab.
 */

const TABS: { id: Exclude<Panel, null>; label: string }[] = [
  { id: "leads", label: "去哪儿" },
  { id: "expeditions", label: "探索" },
  { id: "regions", label: "版图" },
  { id: "paper", label: "详情" },
];

export default function App() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const world = useStore((s) => s.world);
  const save = useStore((s) => s.save);
  const replaceSave = useStore((s) => s.replaceSave);
  const notify = useStore((s) => s.notify);

  const [importing, setImporting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [settings, setSettings] = useState(false);
  const [showingNotes, setShowingNotes] = useState(false);
  const [showingSlots, setShowingSlots] = useState(false);

  const hasPapers = world.papers.length > 0;

  const loadSample = () => {
    replaceSave(createSampleSave());
    notify("info", "已载入示例地图。读过的论文会点亮邻居，写下笔记会照得更远。");
  };

  /**
   * Download the save file. Local-first means the user can always walk away
   * with their data, so this is a plain JSON file rather than a proprietary
   * bundle — it is the same shape the app reads back.
   */
  const exportToFile = () => {
    try {
      const blob = new Blob([exportSave(save)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `yantu-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      notify("error", "导出失败。");
    }
  };

  const renderPanel = () => {
    switch (panel) {
      case "expeditions":
        return <ExpeditionsPanel />;
      case "regions":
        return <RegionsPanel />;
      case "paper":
        return <PaperPanel />;
      case "leads":
      default:
        return <LeadsPanel />;
    }
  };

  const searchRef = useRef<HTMLDivElement>(null);
  const [searchFocused, setSearchFocused] = useState(false);

  // 搜索匹配结果（前 8 条）
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return world.papers
      .filter((p) => {
        const v = world.visibility[p.id] ?? "fog";
        if (v === "fog") return false;
        const haystack = `${p.title} ${p.authors.join(" ")} ${p.venue} ${p.keywords.join(" ")}`;
        return haystack.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [search, world.papers, world.visibility]);

  // 搜索失焦时关闭下拉
  const handleSearchBlur = () => {
    // 延迟关闭以允许点击结果
    setTimeout(() => setSearchFocused(false), 200);
  };

  const select = useStore((s) => s.select);
  const handleSearchResultClick = (id: PaperId) => {
    select(id);
    setSearchFocused(false);
  };

  const counts: Record<string, number> = {
    leads: world.leads.length,
    expeditions: world.quests.length,
    regions: world.regionStatus.filter((r) => r.beckoning).length,
    paper: 0,
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">研图</span>
          <span className="brand-sub">YANTU</span>
        </div>

        <div className="search" ref={searchRef}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={handleSearchBlur}
            placeholder="搜索标题、作者、主题…"
            aria-label="搜索可见的文献"
          />
          {searchFocused && searchResults.length > 0 && (
            <div className="search-dropdown">
              {searchResults.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="search-result-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSearchResultClick(p.id);
                  }}
                >
                  <span className="search-result-title">{p.title}</span>
                  <span className="search-result-meta">
                    {p.authors.slice(0, 2).join("、")}
                    {p.year > 0 && ` · ${p.year}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <Hud />

        <div className="topbar-actions">
          <button
            type="button"
            className="settings-btn"
            aria-label="设置"
            title="设置"
            onClick={() => setSettings(true)}
          >
            ⚙
          </button>
          <button type="button" onClick={() => setImporting(true)}>
            导入文献
          </button>
          {hasPapers && (
            <button type="button" onClick={() => setManaging(true)}>
              管理文献
            </button>
          )}
          {hasPapers && (
            <button type="button" onClick={() => setShowingNotes(true)}>
              笔记回顾
            </button>
          )}
          {hasPapers && (
            <button type="button" onClick={() => {
              const store = useStore.getState();
              store.exportNotesMarkdown();
            }}>
              导出笔记
            </button>
          )}
          {hasPapers && (
            <button type="button" onClick={() => setShowingSlots(true)}>
              存档
            </button>
          )}
          {!hasPapers && (
            <button type="button" className="button-primary" onClick={loadSample}>
              载入示例地图
            </button>
          )}
          {hasPapers && (
            <button type="button" onClick={exportToFile}>
              导出存档
            </button>
          )}
        </div>
      </header>

      <MapCanvas theme={THEME}>
        <MapLegend />
      </MapCanvas>

      <aside className="sidebar">
        <div className="tabs" role="tablist" aria-label="侧栏面板">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={panel === tab.id}
              onClick={() => setPanel(tab.id)}
            >
              {tab.label}
              {counts[tab.id] > 0 && <span className="tab-count">{counts[tab.id]}</span>}
            </button>
          ))}
        </div>

        <div className="panel-body" role="tabpanel">
          {renderPanel()}
        </div>
      </aside>

      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      {managing && <ManagementSheet onClose={() => setManaging(false)} />}
      {settings && <SettingsSheet onClose={() => setSettings(false)} />}
      {showingNotes && <NotesSheet onClose={() => setShowingNotes(false)} />}
      {showingSlots && <SaveSlotSheet onClose={() => setShowingSlots(false)} />}
      <Toast />
    </div>
  );
}
