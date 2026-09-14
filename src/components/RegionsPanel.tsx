import { useCallback, useState } from "react";

import type { AiRegionRefinement } from "../services/ai-types";
import { readAiConfig, isConfigValid } from "../services/ai-config";
import { refineRegion } from "../services/ai";
import type { RegionId } from "../game/types";
import { useStore } from "../state/store";

/**
 * Territory list.
 *
 * Sorted so blind spots surface first. This is the panel that answers "what am
 * I not looking at?" — the question a literature review lives or dies on, and
 * the one a plain paper list can never answer because absence has no row.
 *
 * AI refinement: for any region, the user can ask AI to analyze the papers
 * inside it and produce a structured description, theme breakdown, suggested
 * rename, and key papers.
 */
export default function RegionsPanel() {
  const world = useStore((s) => s.world);
  const save = useStore((s) => s.save);
  const focusRegion = useStore((s) => s.focusRegion);
  const setFocusRegion = useStore((s) => s.setFocusRegion);
  const renameRegion = useStore((s) => s.renameRegion);
  const notify = useStore((s) => s.notify);

  const [editing, setEditing] = useState<RegionId | null>(null);
  const [draft, setDraft] = useState("");

  // AI 细化结果，按区域 id 索引
  const [refinements, setRefinements] = useState<
    Record<RegionId, { loading: boolean; result?: AiRegionRefinement; error?: string }>
  >({});

  const [batchRefining, setBatchRefining] = useState(false);

  if (world.regionStatus.length === 0) {
    return (
      <div className="panel-empty">
        <p>还没有可分析的区域。</p>
      </div>
    );
  }

  // Untouched-but-visible first (those are the actionable gaps), then by how
  // little of the territory has been explored.
  const ordered = [...world.regionStatus].sort((a, b) => {
    if (a.beckoning !== b.beckoning) return a.beckoning ? -1 : 1;
    if (a.untouched !== b.untouched) return a.untouched ? -1 : 1;
    return a.coverage - b.coverage;
  });

  const commitRename = (regionId: string) => {
    renameRegion(regionId, draft);
    setEditing(null);
  };

  const handleRefine = useCallback(
    async (regionId: RegionId, regionName: string) => {
      const config = readAiConfig();
      if (!isConfigValid(config)) {
        notify("error", "请先在设置中完成 AI 配置。");
        return;
      }

      // 收集该区域内的论文
      const region = world.regions.find((r) => r.id === regionId);
      if (!region || region.members.length === 0) {
        notify("error", "该区域没有论文可供分析。");
        return;
      }

      const papers = region.members
        .map((pid) => save.papers[pid])
        .filter((p): p is NonNullable<typeof p> => p != null);

      if (papers.length === 0) {
        notify("error", "该区域没有论文可供分析。");
        return;
      }

      setRefinements((prev) => ({
        ...prev,
        [regionId]: { loading: true },
      }));

      try {
        const result = await refineRegion(config, regionName, papers);
        setRefinements((prev) => ({
          ...prev,
          [regionId]: { loading: false, result },
        }));

        // 如果 AI 建议了更好的名称，自动应用
        if (result.suggestedName && result.suggestedName.trim() && result.suggestedName !== regionName) {
          renameRegion(regionId, result.suggestedName.trim());
          notify("info", `已根据 AI 建议将区域重命名为「${result.suggestedName.trim()}」。`);
        }
      } catch (err) {
        setRefinements((prev) => ({
          ...prev,
          [regionId]: {
            loading: false,
            error: err instanceof Error ? err.message : "AI 分析失败",
          },
        }));
      }
    },
    [world.regions, save.papers, renameRegion, notify],
  );

  const handleBatchRefine = async () => {
    const config = readAiConfig();
    if (!isConfigValid(config)) {
      notify("error", "请先在设置中完成 AI 配置。");
      return;
    }
    setBatchRefining(true);
    let done = 0;
    for (const status of ordered) {
      const region = status.region;
      if (refinements[region.id]?.result) continue; // 已分析过的跳过
      await handleRefine(region.id, region.name);
      done++;
    }
    setBatchRefining(false);
    if (done > 0) {
      notify("info", `已完成 ${done} 个区域的 AI 分析。`);
    } else {
      notify("info", "所有区域都已分析过了。");
    }
  };

  return (
    <div className="regions">
      <p className="panel-note">未踏入的区域排在最前面。地图上看不见的地方，才是综述真正的缺口。</p>

      <div className="region-batch-actions">
        <button
          type="button"
          className="region-batch-ai-btn"
          disabled={batchRefining}
          onClick={handleBatchRefine}
        >
          {batchRefining ? "分析中…" : `AI 批量分析全部区域（${ordered.length} 个）`}
        </button>
      </div>

      {focusRegion && (
        <button type="button" className="clear-focus" onClick={() => setFocusRegion(null)}>
          ← 显示全部区域
        </button>
      )}

      <ul className="region-list">
        {ordered.map((status) => {
          const { region } = status;
          const active = focusRegion === region.id;
          const ref = refinements[region.id];
          return (
            <li key={region.id} className={active ? "region region-active" : "region"}>
              <div className="region-head">
                <button
                  type="button"
                  className="region-name"
                  onClick={() => setFocusRegion(active ? null : region.id)}
                  style={{ borderColor: `hsl(${region.hue}, 60%, 55%)` }}
                >
                  {editing === region.id ? null : region.name}
                </button>

                {editing === region.id ? (
                  <span className="region-rename">
                    <input
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(region.id);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      aria-label={`重命名区域 ${region.name}`}
                    />
                    <button type="button" onClick={() => commitRename(region.id)}>
                      保存
                    </button>
                  </span>
                ) : (
                  <div className="region-actions">
                    <button
                      type="button"
                      className="region-edit"
                      onClick={() => {
                        setEditing(region.id);
                        setDraft(region.name);
                      }}
                      aria-label={`重命名区域 ${region.name}`}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className="region-ai-btn"
                      disabled={ref?.loading}
                      onClick={() => handleRefine(region.id, region.name)}
                      aria-label={`AI 细化区域 ${region.name}`}
                    >
                      {ref?.loading ? "分析中…" : "AI 细化"}
                    </button>
                  </div>
                )}
              </div>

              <div className="region-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.round(status.coverage * 100)}%`,
                    background: `hsl(${region.hue}, 65%, 58%)`,
                  }}
                />
              </div>

              <p className="region-stats">
                已读 {status.lit} / {status.total}
                {status.beckoning && <em className="region-flag"> · 从未踏入</em>}
                {!status.untouched && status.coverage < 0.34 && (
                  <em className="region-flag-soft"> · 只是路过</em>
                )}
              </p>

              {region.keywords.length > 1 && (
                <p className="region-keywords">{region.keywords.slice(1, 5).join(" · ")}</p>
              )}

              {/* AI 细化结果 */}
              {ref?.result && (
                <div className="region-ai-result">
                  <p className="region-ai-desc">{ref.result.description}</p>

                  {ref.result.themes.length > 0 && (
                    <div className="region-ai-section">
                      <span className="region-ai-label">研究主题</span>
                      <ul className="region-ai-themes">
                        {ref.result.themes.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {ref.result.keyPapers.length > 0 && (
                    <div className="region-ai-section">
                      <span className="region-ai-label">关键论文</span>
                      <ul className="region-ai-papers">
                        {ref.result.keyPapers.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {ref.result.distinction && (
                    <div className="region-ai-section">
                      <span className="region-ai-label">独特之处</span>
                      <p className="region-ai-distinction">{ref.result.distinction}</p>
                    </div>
                  )}
                </div>
              )}

              {ref?.error && (
                <p className="region-ai-error">{ref.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}