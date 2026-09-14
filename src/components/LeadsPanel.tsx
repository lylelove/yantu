import { useState } from "react";

import { readAiConfig, isConfigValid } from "../services/ai-config";
import { useStore } from "../state/store";

/**
 * "Where next?" — the ranked frontier.
 *
 * This panel is the app's answer to the question a researcher actually has, and
 * it always shows its reasoning. A recommendation you cannot interrogate is
 * just an oracle; the point here is that the user learns the shape of their own
 * blind spots by reading *why* something was suggested.
 *
 * When AI is configured, each lead gains a button to get an AI-generated
 * explanation of why this paper is worth reading.
 */
export default function LeadsPanel() {
  const world = useStore((s) => s.world);
  const select = useStore((s) => s.select);
  const hover = useStore((s) => s.hover);
  const selectedId = useStore((s) => s.selectedId);
  const notify = useStore((s) => s.notify);

  const [aiReasons, setAiReasons] = useState<
    Record<string, { loading: boolean; text?: string; error?: string }>
  >({});

  const paperById = (id: string) => world.papers.find((p) => p.id === id);

  const explainLeadWithAI = async (
    leadId: string,
    paperTitle: string,
    reasons: string[],
  ) => {
    const config = readAiConfig();
    if (!isConfigValid(config)) {
      notify("error", "请先在设置中完成 AI 配置。");
      return;
    }
    setAiReasons((prev) => ({
      ...prev,
      [leadId]: { loading: true },
    }));
    try {
      const baseUrl = config.baseUrl.replace(/\/+$/, "");
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: "system",
              content:
                "你是一位学术研究助手。请用一段 80-120 字的中文，解释为什么研究者应该阅读这篇论文。" +
                "基于已有的线索理由，给出更具体、更有说服力的推荐原因。直接输出文本，不要添加前缀。",
            },
            {
              role: "user",
              content: `论文标题：${paperTitle}\n已有的线索理由：${reasons.join("；")}`,
            },
          ],
          temperature: 0.3,
          max_tokens: 512,
        }),
      });
      if (!response.ok) {
        throw new Error(`请求失败 (${response.status})`);
      }
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim() || "";
      setAiReasons((prev) => ({
        ...prev,
        [leadId]: { loading: false, text },
      }));
    } catch (err) {
      setAiReasons((prev) => ({
        ...prev,
        [leadId]: {
          loading: false,
          error: err instanceof Error ? err.message : "AI 分析失败",
        },
      }));
    }
  };

  if (world.papers.length === 0) {
    return (
      <div className="panel-empty">
        <p>还没有地图。</p>
        <p>先导入文献或载入示例，才有方向可谈。</p>
      </div>
    );
  }

  if (world.leads.length === 0) {
    return (
      <div className="panel-empty">
        <p>视野边缘暂时没有新线索。</p>
        <p>读完并写下笔记，已读的文献会照亮更远一跳；或者联网扩展，把邻接文献拉进来。</p>
      </div>
    );
  }

  return (
    <div className="leads">
      <p className="panel-note">
        按「陌生程度」排序，而不是按「和你已读的有多像」。越靠前的越可能带你离开熟悉的区域。
      </p>
      <ul className="lead-list">
        {world.leads.map((lead) => {
          const paper = paperById(lead.paperId);
          if (!paper) return null;
          const active = lead.paperId === selectedId;
          return (
            <li key={lead.paperId} className="lead-wrapper">
              <button
                type="button"
                className={`lead${active ? " lead-active" : ""}`}
                onClick={() => select(lead.paperId)}
                onMouseEnter={() => hover(lead.paperId)}
                onMouseLeave={() => hover(null)}
              >
                <span className="lead-title">{paper.title}</span>
                <span className="lead-meta">
                  {paper.year > 0 && <span>{paper.year}</span>}
                  {paper.venue && <span>{paper.venue}</span>}
                  {paper.citedByCount > 0 && <span>被引 {paper.citedByCount.toLocaleString()}</span>}
                </span>
                <ul className="lead-reasons">
                  {lead.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
                <span className="lead-bars" aria-hidden="true">
                  <span className="lead-bar" title={`陌生 ${Math.round(lead.novelty * 100)}%`}>
                    <span style={{ width: `${lead.novelty * 100}%` }} className="bar-novelty" />
                  </span>
                  <span className="lead-bar" title={`桥梁 ${Math.round(lead.bridge * 100)}%`}>
                    <span style={{ width: `${lead.bridge * 100}%` }} className="bar-bridge" />
                  </span>
                  <span className="lead-bar" title={`可达 ${Math.round(lead.reachability * 100)}%`}>
                    <span style={{ width: `${lead.reachability * 100}%` }} className="bar-reach" />
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="lead-ai-btn"
                disabled={aiReasons[lead.paperId]?.loading}
                onClick={(e) => {
                  e.stopPropagation();
                  explainLeadWithAI(lead.paperId, paper.title, lead.reasons);
                }}
              >
                {aiReasons[lead.paperId]?.loading ? "分析中…" : "AI 解读"}
              </button>
              {aiReasons[lead.paperId]?.text && (
                <div className="lead-ai-text">
                  {aiReasons[lead.paperId]!.text}
                </div>
              )}
              {aiReasons[lead.paperId]?.error && (
                <p className="ai-explanation-error">{aiReasons[lead.paperId]!.error}</p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="panel-legend" aria-hidden="true">
        <span className="swatch bar-novelty" /> 陌生
        <span className="swatch bar-bridge" /> 桥梁
        <span className="swatch bar-reach" /> 可达
      </p>
    </div>
  );
}
