import { useState } from "react";

import type { Paper } from "../game/types";
import { fetchPaperMetadata } from "../services/openalex";
import { useStore } from "../state/store";

/**
 * Literature management dialog.
 *
 * Provides an overview of all papers by source, the ability to clear imported
 * papers, and a one-click action to fetch missing abstracts and keywords from
 * OpenAlex for papers that have a resolvable identifier.
 */
export default function ManagementSheet({ onClose }: { onClose: () => void }) {
  const world = useStore((s) => s.world);
  const removePapers = useStore((s) => s.removePapers);
  const updatePaper = useStore((s) => s.updatePaper);
  const notify = useStore((s) => s.notify);
  const setBusy = useStore((s) => s.setBusy);
  const busy = useStore((s) => s.busy);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"all" | "overview" | "imported" | "missing">("all");

  const papers = world.papers;

  // Group papers by source
  const importedPapers = papers.filter((p) => p.source === "import");
  const openalexPapers = papers.filter((p) => p.source === "openalex");
  const seedPapers = papers.filter((p) => p.source === "seed");

  // Papers whose metadata has not yet been checked via OpenAlex, with a resolvable identifier.
  const missingMeta = papers.filter(
    (p) =>
      !p.metaCheckedAt &&
      (!p.abstract || p.keywords.length === 0 || p.citedByCount <= 0) &&
      (Boolean(p.doi) ||
        p.id.startsWith("doi:") ||
        p.id.startsWith("oa:") ||
        (p.aliases ?? []).some((a) => a.startsWith("doi:") || a.startsWith("oa:"))),
  );

  const batchMetaKey = "batch-fetch-meta";
  const fetchingAll = Boolean(busy[batchMetaKey]);

  const list: Paper[] =
    tab === "all" ? papers : tab === "imported" ? importedPapers : tab === "missing" ? missingMeta : [];

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(list.map((p) => p.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleRemoveSelected = () => {
    if (selectedIds.size === 0) return;
    removePapers([...selectedIds]);
    setSelectedIds(new Set());
    notify("info", `已删除 ${selectedIds.size} 篇文献。`);
  };

  const handleClearImported = () => {
    if (importedPapers.length === 0) return;
    const ids = importedPapers.map((p) => p.id);
    removePapers(ids);
    notify("info", `已清空 ${ids.length} 篇导入的文献。`);
  };

  /**
   * Batch-fetch missing abstracts and keywords for all papers that need them.
   * Processes papers sequentially to avoid rate-limiting.
   */
  const handleFetchAllMeta = async () => {
    if (missingMeta.length === 0) {
      notify("info", "所有文献已有完整的元数据。");
      return;
    }
    setBusy(batchMetaKey, true);
    let fetched = 0;
    let apiFailed = 0;
    let noData = 0;
    for (const paper of missingMeta) {
      try {
        const result = await fetchPaperMetadata(paper);
        if (!result) {
          noData++;
          continue;
        }
        const updates: Partial<typeof paper> = {};
        if (!paper.abstract) updates.abstract = result.abstract;
        if (paper.keywords.length === 0) updates.keywords = result.keywords;
        if (paper.citedByCount <= 0) updates.citedByCount = result.citedByCount;
        updatePaper(paper.id, { ...updates, metaCheckedAt: new Date().toISOString() });
        fetched++;
      } catch {
        apiFailed++;
      }
    }
    setBusy(batchMetaKey, false);
    const parts: string[] = [];
    if (fetched > 0) parts.push(`已获取 ${fetched} 篇`);
    if (noData > 0) parts.push(`${noData} 篇在 OpenAlex 中也没有更多数据`);
    if (apiFailed > 0) parts.push(`${apiFailed} 篇请求失败`);
    notify("info", parts.join("，") + "。");
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="管理文献"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet sheet-wide">
        <h2>管理文献</h2>

        {/* Overview stats */}
        <div className="manage-stats">
          <div className="manage-stat">
            <strong>{papers.length}</strong>
            <span>全部文献</span>
          </div>
          <div className="manage-stat">
            <strong>{importedPapers.length}</strong>
            <span>导入</span>
          </div>
          <div className="manage-stat">
            <strong>{openalexPapers.length}</strong>
            <span>联网获取</span>
          </div>
          <div className="manage-stat">
            <strong>{seedPapers.length}</strong>
            <span>示例</span>
          </div>
          <div className="manage-stat">
            <strong>{missingMeta.length}</strong>
            <span>缺摘要/关键词</span>
          </div>
        </div>

        {/* Tab bar */}
        <div className="manage-tabs">
          <button
            type="button"
            className={tab === "all" ? "active" : ""}
            onClick={() => setTab("all")}
          >
            全部文献 ({papers.length})
          </button>
          <button
            type="button"
            className={tab === "overview" ? "active" : ""}
            onClick={() => setTab("overview")}
          >
            概览
          </button>
          <button
            type="button"
            className={tab === "imported" ? "active" : ""}
            onClick={() => setTab("imported")}
          >
            导入的文献 ({importedPapers.length})
          </button>
          <button
            type="button"
            className={tab === "missing" ? "active" : ""}
            onClick={() => setTab("missing")}
          >
            缺元数据 ({missingMeta.length})
          </button>
        </div>

        {/* Bulk actions */}
        {tab === "all" && papers.length > 0 && (
          <div className="manage-bulk-actions">
            <button type="button" className="button-danger" onClick={() => {
              const ids = papers.map((p) => p.id);
              removePapers(ids);
              notify("info", `已删除全部 ${ids.length} 篇文献。`);
            }}>
              清空全部文献
            </button>
          </div>
        )}

        {tab === "imported" && importedPapers.length > 0 && (
          <div className="manage-bulk-actions">
            <button type="button" className="button-danger" onClick={handleClearImported}>
              清空导入的文献
            </button>
          </div>
        )}

        {tab === "missing" && missingMeta.length > 0 && (
          <div className="manage-bulk-actions">
            <button type="button" onClick={handleFetchAllMeta} disabled={fetchingAll}>
              {fetchingAll
                ? `获取中…（${missingMeta.length} 篇）`
                : `一键获取摘要和关键词（${missingMeta.length} 篇）`}
            </button>
          </div>
        )}

        {/* Paper list with selection */}
        {list.length > 0 && (
          <div className="manage-list-wrap">
            <div className="manage-list-toolbar">
              <span className="manage-list-count">{list.length} 篇</span>
              <button type="button" className="link" onClick={selectAll}>
                全选
              </button>
              <button type="button" className="link" onClick={deselectAll}>
                取消全选
              </button>
              {selectedIds.size > 0 && (
                <button type="button" className="link danger-link" onClick={handleRemoveSelected}>
                  删除选中 ({selectedIds.size})
                </button>
              )}
            </div>
            <ul className="manage-list">
              {list.map((p) => (
                <li
                  key={p.id}
                  className={`manage-item${selectedIds.has(p.id) ? " selected" : ""}`}
                >
                  <label className="manage-item-label">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                    />
                    <span className="manage-item-info">
                      <span className="manage-item-title">{p.title}</span>
                      <span className="manage-item-meta">
                        {p.authors.length > 0 && (
                          <span>{p.authors.slice(0, 3).join("、")}{p.authors.length > 3 ? " 等" : ""}</span>
                        )}
                        {p.year > 0 && <span>{p.year}</span>}
                        {p.doi && <span className="manage-item-doi">{p.doi}</span>}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "all" && papers.length === 0 && (
          <p className="panel-empty" style={{ marginTop: 12 }}>
            还没有文献。
          </p>
        )}

        {tab === "imported" && importedPapers.length === 0 && (
          <p className="panel-empty" style={{ marginTop: 12 }}>
            还没有导入的文献。
          </p>
        )}

        {tab === "missing" && missingMeta.length === 0 && (
          <p className="panel-empty" style={{ marginTop: 12 }}>
            所有文献都有完整的摘要和关键词。
          </p>
        )}

        {tab === "overview" && (
          <div className="manage-overview-detail">
            <p>
              管理你的文献库。你可以查看各来源的文献数量，批量删除导入的文献，
              或者一键从 OpenAlex 获取缺失的摘要和关键词。
            </p>
          </div>
        )}

        <div className="sheet-actions" style={{ marginTop: 13 }}>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}