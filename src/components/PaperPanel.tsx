import { useEffect, useMemo, useRef, useState } from "react";

import type { PaperId, ReadState } from "../game/types";
import { VISIBILITY_LABELS } from "../render/palette";
import type { AiRelationExplanation } from "../services/ai-types";
import { readAiConfig, isConfigValid } from "../services/ai-config";
import { explainRelation, summarizePaper } from "../services/ai";
import { fetchPaperMetadata, fetchRelatedWorks } from "../services/openalex";
import { useStore } from "../state/store";

/**
 * The detail panel for one paper.
 *
 * Two jobs. First, show what the paper is. Second — and this is the part that
 * matters to the game — let the user record what they did with it, because read
 * state and notes are the inputs that push back the fog. The note field is not
 * a nicety here: writing one promotes a paper to a beacon and literally widens
 * the visible map.
 */

const READ_STATES: { value: ReadState; label: string; hint: string }[] = [
  { value: "unread", label: "未读", hint: "还没开始" },
  { value: "reading", label: "在读", hint: "已识别，正在读" },
  { value: "read", label: "已读", hint: "点亮它，照见邻居" },
  { value: "mastered", label: "读透", hint: "当作灯塔，照得更远" },
];

export default function PaperPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const world = useStore((s) => s.world);
  const setReadState = useStore((s) => s.setReadState);
  const setNote = useStore((s) => s.setNote);
  const updatePaper = useStore((s) => s.updatePaper);
  const addPapers = useStore((s) => s.addPapers);
  const select = useStore((s) => s.select);
  const setBusy = useStore((s) => s.setBusy);
  const notify = useStore((s) => s.notify);
  const busy = useStore((s) => s.busy);
  const save = useStore((s) => s.save);

  const paper = useMemo(
    () => (selectedId ? world.papers.find((p) => p.id === selectedId) : undefined),
    [selectedId, world.papers],
  );

  // Read from the derived world, never `save.progress`: after a merge the raw
  // save may still key this paper's progress under a superseded id.
  const progress = selectedId ? world.progress[selectedId] : undefined;

  // Local mirror of the note so typing stays responsive; the store write is
  // debounced through the save layer anyway.  Flush pending note to the
  // previous paper when selection changes so fast switching never drops text.
  const [draftNote, setDraftNote] = useState("");
  const prevSelectedRef = useRef<PaperId | null>(null);
  useEffect(() => {
    const prevId = prevSelectedRef.current;
    prevSelectedRef.current = selectedId ?? null;
    if (prevId !== null && prevId !== selectedId) {
      const prevNote = world.progress[prevId]?.note ?? "";
      if (draftNote !== prevNote) setNote(prevId, draftNote);
    }
    setDraftNote(progress?.note ?? "");
  }, [selectedId]);

  // AI 关系解释状态，按目标论文 id 索引
  const [aiExplanations, setAiExplanations] = useState<
    Record<string, { loading: boolean; result?: AiRelationExplanation; error?: string }>
  >({});

  // AI 摘要状态
  const [aiSummary, setAiSummary] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });

  // 是否已尝试过从 OpenAlex 获取元数据
  const [metaAttempted, setMetaAttempted] = useState(false);

  if (!paper || !selectedId) {
    return (
      <div className="panel-empty">
        <p>点击地图上的任意节点查看详情。</p>
      </div>
    );
  }

  const visibility = world.visibility[paper.id] ?? "fog";
  const region = world.regions.find((r) => r.members.includes(paper.id));
  const expandKey = `expand:${paper.id}`;
  const expanding = Boolean(busy[expandKey]);
  const metaKey = `meta:${paper.id}`;
  const fetchingMeta = Boolean(busy[metaKey]);

  // Does this paper have a DOI or OpenAlex id we could query?
  // Falls back to title search in fetchPaperMetadata, so any paper with
  // a title and missing metadata is eligible.
  const dismissPaper = useStore((s) => s.dismissPaper);

  const hasOnlineId = Boolean(paper.title.trim());
  const missingAbstract = !paper.abstract;
  const missingKeywords = paper.keywords.length === 0;
  const missingCitedBy = paper.citedByCount <= 0;
  const canFetchMeta = hasOnlineId && (missingAbstract || missingKeywords || missingCitedBy) && !metaAttempted;

  // Neighbours we already hold, so the user can walk the map from here.
  const neighbours = world.edges
    .filter((e) => e.source === paper.id || e.target === paper.id)
    .map((e) => ({
      id: e.source === paper.id ? e.target : e.source,
      kind: e.kind,
    }))
    .filter((n, i, arr) => arr.findIndex((m) => m.id === n.id) === i)
    .slice(0, 12);

  const commitNote = () => {
    if (draftNote !== (progress?.note ?? "")) setNote(paper.id, draftNote);
  };

  /**
   * Pull this paper's neighbourhood from OpenAlex.
   *
   * This is the explicit, per-paper networked action. It is never automatic:
   * the user's library stays local unless they ask for an expansion, and even
   * then we only send the one identifier being expanded.
   */
  const expand = async () => {
    setBusy(expandKey, true);
    try {
      const related = await fetchRelatedWorks(paper, { perPage: 25 });
      if (related.length === 0) {
        notify("info", "没有找到新的邻接文献。");
        return;
      }
      const { added, merged } = addPapers(related);
      notify(
        "info",
        added > 0
          ? `拉入 ${added} 篇新文献${merged > 0 ? `，另有 ${merged} 篇与已有记录合并` : ""}。`
          : "邻接文献都已经在你的地图里了。",
      );
    } catch (err) {
      notify("error", `联网扩展失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setBusy(expandKey, false);
    }
  };

  /**
   * Fetch abstract and keywords from OpenAlex for this paper.
   */
  const fetchMeta = async () => {
    setBusy(metaKey, true);
    try {
      const result = await fetchPaperMetadata(paper);
      if (!result) {
        setMetaAttempted(true);
        updatePaper(paper.id, { metaCheckedAt: new Date().toISOString() });
        notify("info", "未能在 OpenAlex 找到这篇文献。");
        return;
      }
      const updates: Partial<typeof paper> = {};
      if (missingAbstract) updates.abstract = result.abstract;
      if (missingKeywords) updates.keywords = result.keywords;
      if (missingCitedBy) updates.citedByCount = result.citedByCount;
      updatePaper(paper.id, { ...updates, metaCheckedAt: new Date().toISOString() });

      setMetaAttempted(true);

      const got: string[] = [];
      if (missingAbstract && result.abstract) got.push("摘要");
      if (missingKeywords && result.keywords.length > 0) got.push("关键词");
      if (missingCitedBy) got.push("被引数");

      const notFound: string[] = [];
      if (missingAbstract && !result.abstract) notFound.push("摘要");

      if (got.length > 0) {
        notify("info", `已获取${got.join("、")}。${notFound.length > 0 ? `OpenAlex 中也没有${notFound.join("、")}。` : ""}`);
      } else if (notFound.length > 0) {
        notify("info", `OpenAlex 中也没有${notFound.join("、")}。`);
      } else {
        notify("info", "这篇文献已有完整的元数据。");
      }
    } catch (err) {
      notify("error", `获取元数据失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setBusy(metaKey, false);
    }
  };

  return (
    <div className="paper-panel">
      <span className={`vis-badge vis-${visibility}`}>{VISIBILITY_LABELS[visibility]}</span>
      <h2 className="paper-title">{paper.title}</h2>

      <p className="paper-meta">
        {paper.authors.length > 0 && <span>{paper.authors.slice(0, 4).join("、")}{paper.authors.length > 4 ? " 等" : ""}</span>}
        {paper.year > 0 && <span>{paper.year}</span>}
        {paper.venue && <span>{paper.venue}</span>}
        {paper.citedByCount > 0 && <span>被引 {paper.citedByCount.toLocaleString()}</span>}
      </p>

      {region && (
        <p className="paper-region">
          所属区域：<button type="button" className="link" onClick={() => useStore.getState().setFocusRegion(region.id)}>{region.name}</button>
        </p>
      )}

      {paper.abstract ? (
        <p className="paper-abstract">{paper.abstract}</p>
      ) : (
        <p className="paper-missing-hint">暂无摘要。</p>
      )}

      {paper.keywords.length > 0 ? (
        <ul className="tag-row">
          {paper.keywords.slice(0, 8).map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      ) : (
        <p className="paper-missing-hint">暂无关键词。</p>
      )}

      {canFetchMeta && (
        <div className="paper-actions" style={{ marginTop: 8 }}>
          <button type="button" onClick={fetchMeta} disabled={fetchingMeta}>
            {fetchingMeta
              ? "获取中…"
              : `从 OpenAlex 获取${missingAbstract ? "摘要" : ""}${(missingAbstract && missingKeywords) || (missingAbstract && missingCitedBy) ? "和" : ""}${missingKeywords ? "关键词" : ""}${(missingKeywords && missingCitedBy) || (missingAbstract && missingCitedBy) ? "和" : ""}${missingCitedBy ? "被引数" : ""}`}
          </button>
        </div>
      )}

      <fieldset className="read-states">
        <legend>阅读状态</legend>
        {READ_STATES.map((s) => (
          <label key={s.value} className={progress?.state === s.value ? "chosen" : ""} title={s.hint}>
            <input
              type="radio"
              name="read-state"
              value={s.value}
              checked={(progress?.state ?? "unread") === s.value}
              onChange={() => setReadState(paper.id, s.value)}
              tabIndex={-1}
            />
            {s.label}
          </label>
        ))}
      </fieldset>

      <label className="note-field">
        <span>
          笔记
          <em>写下想法，这篇会成为灯塔，照亮更远一跳</em>
          {aiSummary.loading && <span className="ai-summary-status">AI 摘要生成中…</span>}
          {aiSummary.text && <span className="ai-summary-status success">摘要已生成</span>}
        </span>
        <textarea
          value={draftNote}
          onChange={(e) => setDraftNote(e.target.value)}
          onBlur={commitNote}
          rows={4}
          placeholder="它解决了什么问题？和你在读的东西怎么接上？"
        />
      </label>

      <div className="paper-actions">
        <button
          type="button"
          onClick={async () => {
            const config = readAiConfig();
            if (!isConfigValid(config)) {
              notify("error", "请先在设置中完成 AI 配置。");
              return;
            }
            setAiSummary({ loading: true });
            try {
              const text = await summarizePaper(config, paper);
              setAiSummary({ loading: false, text });
            } catch (err) {
              setAiSummary({ loading: false, error: err instanceof Error ? err.message : "生成摘要失败" });
            }
          }}
          disabled={aiSummary.loading}
        >
          {aiSummary.loading ? "生成中…" : "AI 生成摘要"}
        </button>
        <button type="button" onClick={expand} disabled={expanding}>
          {expanding ? "扩展中…" : "联网扩展邻接文献"}
        </button>
        {(paper.url || paper.doi) && (
          <a
            className="button-like"
            href={paper.url ?? `https://doi.org/${paper.doi}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            打开原文
          </a>
        )}
      </div>

      {save.dismissed.includes(paper.id) ? (
        <div className="dismissed-notice">
          <p>这篇文献已被屏蔽，不会出现在线索和探索任务中。</p>
          <button type="button" className="link" onClick={() => useStore.getState().undismissPaper(paper.id)}>
            撤销屏蔽
          </button>
        </div>
      ) : (
        <div className="paper-actions">
          <button type="button" className="button-danger" onClick={() => {
            dismissPaper(paper.id);
            notify("info", "已屏蔽这篇文献。");
          }}>
            标记为不相关
          </button>
        </div>
      )}

      {/* AI 摘要结果 */}
      {aiSummary.text && (
        <div className="ai-summary-result">
          <p>{aiSummary.text}</p>
        </div>
      )}
      {aiSummary.error && (
        <p className="ai-explanation-error">{aiSummary.error}</p>
      )}

      {neighbours.length > 0 && (
        <div className="neighbours">
          <h3>相邻文献</h3>
          <ul>
            {neighbours.map((n) => {
              const np = world.papers.find((p) => p.id === n.id);
              const nv = world.visibility[n.id] ?? "fog";
              if (!np || nv === "fog") return null;
              const aiState = aiExplanations[n.id];
              return (
                <li key={n.id} className="neighbour-item">
                  <div className="neighbour-head">
                    <button type="button" className="link" onClick={() => select(n.id)}>
                      {np.title}
                    </button>
                    <span className={`edge-kind kind-${n.kind}`}>{n.kind === "cites" ? "引用" : n.kind === "coauthor" ? "同作者" : n.kind === "keyword" ? "主题" : n.kind === "venue" ? "同刊" : "手动"}</span>
                  </div>
                  <button
                    type="button"
                    className="ai-explain-btn"
                    disabled={aiState?.loading}
                    onClick={async () => {
                      const config = readAiConfig();
                      if (!isConfigValid(config)) {
                        notify("error", "请先在设置中完成 AI 配置。");
                        return;
                      }
                      setAiExplanations((prev) => ({
                        ...prev,
                        [n.id]: { loading: true },
                      }));
                      try {
                        const result = await explainRelation(config, paper, np);
                        setAiExplanations((prev) => ({
                          ...prev,
                          [n.id]: { loading: false, result },
                        }));
                      } catch (err) {
                        setAiExplanations((prev) => ({
                          ...prev,
                          [n.id]: {
                            loading: false,
                            error: err instanceof Error ? err.message : "分析失败",
                          },
                        }));
                      }
                    }}
                  >
                    {aiState?.loading ? "分析中…" : "AI 分析关系"}
                  </button>
                  {aiState?.result && (
                    <div className="ai-explanation">
                      <strong>{aiState.result.summary}</strong>
                      <p>{aiState.result.detail}</p>
                      {aiState.result.evidence.length > 0 && (
                        <ul className="ai-evidence">
                          {aiState.result.evidence.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {aiState?.error && (
                    <p className="ai-explanation-error">{aiState.error}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}