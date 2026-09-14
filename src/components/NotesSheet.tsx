import { useMemo, useState } from "react";

import { useStore } from "../state/store";

/**
 * 笔记检索与回顾面板。
 *
 * 列出所有写了笔记的文献，按区域分组、按时间排序。
 * 支持搜索过滤，点击笔记可定位到地图上的对应论文。
 */
export default function NotesSheet({ onClose }: { onClose: () => void }) {
  const world = useStore((s) => s.world);
  const select = useStore((s) => s.select);
  const setPanel = useStore((s) => s.setPanel);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupBy, setGroupBy] = useState<"region" | "time">("region");

  // 收集有笔记的论文
  const notes = useMemo(() => {
    const result = world.papers
      .map((p) => ({
        paper: p,
        progress: world.progress[p.id],
      }))
      .filter(({ progress }) => progress && progress.note.trim().length > 0);

    // 搜索过滤
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? result.filter(
          ({ paper, progress }) =>
            paper.title.toLowerCase().includes(q) ||
            paper.authors.some((a) => a.toLowerCase().includes(q)) ||
            progress.note.toLowerCase().includes(q),
        )
      : result;

    // 排序
    if (groupBy === "region") {
      // 按区域分组，区域内按 litAt 排序
      const byRegion = new Map<string, typeof filtered>();
      for (const item of filtered) {
        const region = world.regions.find((r) => r.members.includes(item.paper.id));
        const key = region?.name ?? "未分区";
        if (!byRegion.has(key)) byRegion.set(key, []);
        byRegion.get(key)!.push(item);
      }
      // 对每个区域内的笔记排序
      for (const [, items] of byRegion) {
        items.sort(
          (a, b) =>
            (b.progress.litAt ?? "").localeCompare(a.progress.litAt ?? ""),
        );
      }
      return Array.from(byRegion.entries()).sort(([a], [b]) => a.localeCompare(b));
    } else {
      // 按 litAt 时间倒序排列
      filtered.sort(
        (a, b) =>
          (b.progress.litAt ?? "").localeCompare(a.progress.litAt ?? ""),
      );
      return [["全部", filtered] as const];
    }
  }, [world.papers, world.progress, world.regions, searchQuery, groupBy]);

  const totalNotes = notes.reduce((sum, [, items]) => sum + items.length, 0);

  const handleSelect = (id: string) => {
    select(id);
    setPanel("paper");
    onClose();
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="笔记回顾"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet sheet-wide">
        <h2>笔记回顾</h2>
        <p>你写过的全部笔记，按区域分组排列。笔记是思考的沉淀，也是一篇文献成为灯塔的凭证。</p>

        {/* 工具栏 */}
        <div className="notes-toolbar">
          <input
            type="search"
            className="settings-input"
            placeholder="搜索笔记内容、标题、作者…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <div className="notes-group-toggle">
            <button
              type="button"
              className={groupBy === "region" ? "active" : ""}
              onClick={() => setGroupBy("region")}
            >
              按区域
            </button>
            <button
              type="button"
              className={groupBy === "time" ? "active" : ""}
              onClick={() => setGroupBy("time")}
            >
              按时间
            </button>
          </div>
        </div>

        {totalNotes === 0 ? (
          <div className="panel-empty" style={{ marginTop: 12 }}>
            {searchQuery ? (
              <p>没有匹配的笔记。</p>
            ) : (
              <p>
                还没有笔记。<br />
                在文献详情页面写下想法，这篇文献会成为灯塔，照亮更远的地方。
              </p>
            )}
          </div>
        ) : (
          <div className="notes-content">
            <p className="notes-count">共 {totalNotes} 条笔记</p>
            {notes.map(([regionName, items]) => (
              <div key={regionName} className="notes-region">
                <h3 className="notes-region-title">{regionName}</h3>
                <ul className="notes-list">
                  {items.map(({ paper, progress }) => (
                    <li key={paper.id} className="notes-item">
                      <button
                        type="button"
                        className="notes-item-head link"
                        onClick={() => handleSelect(paper.id)}
                      >
                        <span className="notes-item-title">{paper.title}</span>
                        <span className="notes-item-meta">
                          {paper.authors.slice(0, 2).join("、")}
                          {paper.year > 0 && ` · ${paper.year}`}
                          {progress.litAt && ` · ${progress.litAt.slice(0, 10)}`}
                        </span>
                      </button>
                      <p className="notes-item-text">{progress.note}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="sheet-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}