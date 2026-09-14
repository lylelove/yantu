/**
 * AI 服务层。
 *
 * 通过 OpenAI 兼容 API 提供 AI 辅助功能。支持任意兼容的提供商
 * （OpenAI、DeepSeek、SiliconFlow、本地 ollama 等）。
 *
 * 所有请求都通过用户配置的 baseUrl/apiKey 发送，Yantu 本身不介入
 * 请求内容，也不收集任何用户数据。
 */

import type { AiChatRequest, AiChatResponse, AiConfig, AiRegionRefinement, AiRelationExplanation } from "./ai-types";
export type { AiRelationExplanation, AiRegionRefinement };
import { isConfigValid } from "./ai-config";
import { fetchAiApi } from "./ai-proxy-fetch";

// ---------------------------------------------------------------------------
// Tauri IPC proxy — bypasses browser CORS restrictions
// ---------------------------------------------------------------------------

let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

/** Detect whether we are running inside a Tauri desktop window. */
async function getTauriInvoke(): Promise<typeof tauriInvoke> {
  if (tauriInvoke !== null) return tauriInvoke;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // Verify it actually works by checking the environment
    const { getVersion } = await import("@tauri-apps/api/app");
    await getVersion();
    tauriInvoke = invoke;
  } catch {
    tauriInvoke = null;
  }
  return tauriInvoke;
}

// ---------------------------------------------------------------------------
// 底层 API 调用
// ---------------------------------------------------------------------------

async function chatCompletion(config: AiConfig, request: AiChatRequest, signal?: AbortSignal): Promise<AiChatResponse> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const body = JSON.stringify({
    ...request,
    temperature: request.temperature ?? 0.3,
    max_tokens: request.max_tokens ?? 1024,
  });

  // Try Tauri IPC proxy first (bypasses CORS), fall back to Vite proxy or direct fetch.
  const invoke = await getTauriInvoke();
  if (invoke) {
    try {
      const result = await invoke("ai_proxy", {
        request: {
          url,
          method: "POST",
          headers: Object.entries(headers),
          body,
        },
      }) as { status: number; body: string };

      if (result.status >= 400) {
        throw new Error(`AI 请求失败 (${result.status}): ${result.body.slice(0, 500)}`);
      }
      return JSON.parse(result.body);
    } catch (err) {
      if (err instanceof Error && (err.message.includes("AI 请求失败") || err.message.includes("JSON"))) {
        throw err;
      }
      // Fall through to Vite proxy or direct fetch
    }
  }

  // Web (Vite dev + Cloudflare Pages): same-origin proxy bypasses CORS.
  if (typeof window !== "undefined") {
    const proxyResponse = await fetchAiApi(url, {
      method: "POST",
      headers,
      body,
      signal,
    });
    if (!proxyResponse.ok) {
      const text = await proxyResponse.text().catch(() => "无响应体");
      throw new Error(`AI 请求失败 (${proxyResponse.status}): ${text}`);
    }
    return proxyResponse.json();
  }

  throw new Error("AI 请求在当前环境不可用。");
}

// ---------------------------------------------------------------------------
// 功能函数
// ---------------------------------------------------------------------------

/** 系统提示词：论文关系分析 */
const RELATION_SYSTEM_PROMPT = `你是一位学术研究助手，擅长分析学术文献之间的关系。
请根据两篇论文的元数据（标题、作者、摘要、关键词等），分析它们之间的关系。

请返回 JSON 格式（不要包含 markdown 代码块标记）：

{
  "summary": "一句话概括两篇论文的关系类型（例如：'两篇论文研究同一个主题的不同方法'、'后者引用了前者的理论基础'、'两篇论文来自同一团队的研究脉络'等）",
  "detail": "200-300 字的中文详细分析，说明两篇论文具体在哪些方面相关（方法、理论、应用场景、结论等），有什么异同",
  "evidence": [
    "列出判断依据，如共享的关键词、引用的重叠、相同作者、相似的研究方法等"
  ]
}`;

/**
 * 分析两篇论文之间的关系。
 *
 * @param config  AI 配置
 * @param paperA  第一篇论文信息（标题+摘要+关键词等）
 * @param paperB  第二篇论文信息
 * @param signal  可选的 AbortSignal
 * @returns       结构化的关系解释
 */
export async function explainRelation(
  config: AiConfig,
  paperA: { title: string; authors: string[]; abstract: string; keywords: string[]; year: number; venue: string },
  paperB: { title: string; authors: string[]; abstract: string; keywords: string[]; year: number; venue: string },
  signal?: AbortSignal,
): Promise<AiRelationExplanation> {
  if (!isConfigValid(config)) {
    throw new Error("AI 配置不完整，请先在设置中完成配置。");
  }

  const userMessage = `请分析以下两篇论文之间的关系：

【论文 A】
标题：${paperA.title}
作者：${paperA.authors.join("、")}
年份：${paperA.year}
期刊/会议：${paperA.venue}
关键词：${paperA.keywords.join("、")}
摘要：${paperA.abstract || "(无摘要)"}

【论文 B】
标题：${paperB.title}
作者：${paperB.authors.join("、")}
年份：${paperB.year}
期刊/会议：${paperB.venue}
关键词：${paperB.keywords.join("、")}
摘要：${paperB.abstract || "(无摘要)"}`;

  const response = await chatCompletion(
    config,
    {
      model: config.model,
      messages: [
        { role: "system", content: RELATION_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    },
    signal,
  );

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 返回了空响应");

  // 尝试解析 JSON，兼容模型可能返回 markdown 代码块的情况
  const jsonStr = content.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/g, "").trim();
  try {
    const parsed = JSON.parse(jsonStr) as AiRelationExplanation;
    return {
      summary: parsed.summary || "关系分析结果",
      detail: parsed.detail || "",
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    };
  } catch {
    // 如果解析失败，把原始内容作为 detail 返回
    return {
      summary: "关系分析",
      detail: content,
      evidence: [],
    };
  }
}

/**
 * 生成一篇论文的中文摘要总结（用于笔记建议）。
 */
export async function summarizePaper(
  config: AiConfig,
  paper: { title: string; authors: string[]; abstract: string; keywords: string[]; year: number },
  signal?: AbortSignal,
): Promise<string> {
  if (!isConfigValid(config)) {
    throw new Error("AI 配置不完整，请先在设置中完成配置。");
  }

  const systemPrompt = `你是一位学术研究助手。请用 100-150 字的中文总结这篇论文的核心贡献。要求：
- 第一句说明论文解决了什么核心问题
- 第二句说明采用什么方法
- 第三句说明主要发现或结论
- 直接输出总结文本，不要添加任何前缀`;

  const userMessage = `标题：${paper.title}
作者：${paper.authors.join("、")}
年份：${paper.year}
关键词：${paper.keywords.join("、")}
摘要：${paper.abstract || "(无摘要)"}`;

  const response = await chatCompletion(
    config,
    {
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 512,
    },
    signal,
  );

  return response.choices?.[0]?.message?.content?.trim() || "";
}

// ---------------------------------------------------------------------------
// 区域细化
// ---------------------------------------------------------------------------

/** 系统提示词：区域分析 */
const REGION_REFINE_SYSTEM_PROMPT = `你是一位学术研究助手，擅长分析学术文献的聚类结果。
给定一个研究主题区域内的论文列表，请分析这个区域并返回 JSON 格式的分析结果（不要包含 markdown 代码块标记）：

{
  "description": "100-200 字的中文描述，概括这个区域的研究主题、核心问题和方法取向",
  "suggestedName": "如果当前名称不够准确，给出一个更贴切的名称（可选）",
  "themes": ["列出 3-5 个该区域内主要的研究主题或方向"],
  "keyPapers": ["列出该区域内最具代表性或引用最高的 3-5 篇论文标题"],
  "distinction": "50-100 字说明这个区域与其他区域相比的独特之处"
}`;

/**
 * 用 AI 细化对一个研究区域的分析。
 *
 * @param config    AI 配置
 * @param regionName  当前区域名称
 * @param papers      该区域内的论文列表（标题+摘要+关键词）
 * @param signal      可选的 AbortSignal
 * @returns           结构化的区域细化分析
 */
export async function refineRegion(
  config: AiConfig,
  regionName: string,
  papers: { title: string; authors: string[]; abstract: string; keywords: string[]; year: number }[],
  signal?: AbortSignal,
): Promise<AiRegionRefinement> {
  if (!isConfigValid(config)) {
    throw new Error("AI 配置不完整，请先在设置中完成配置。");
  }

  if (papers.length === 0) {
    throw new Error("该区域没有论文可供分析。");
  }

  // 构造论文列表：取前 30 篇（摘要截断避免超长 context）
  const sample = papers.slice(0, 30);
  const paperList = sample
    .map((p, i) => {
      const abs = p.abstract
        ? p.abstract.length > 300
          ? p.abstract.slice(0, 300) + "…"
          : p.abstract
        : "(无摘要)";
      return `[${i + 1}] ${p.title}（${p.year}）
    作者：${p.authors.slice(0, 3).join("、")}${p.authors.length > 3 ? " 等" : ""}
    关键词：${p.keywords.join("、") || "(无)"}
    摘要：${abs}`;
    })
    .join("\n\n");

  const userMessage = `请分析以下研究区域。

区域名称：${regionName}
区域内的论文（共 ${papers.length} 篇，列出前 ${sample.length} 篇）：

${paperList}`;

  const response = await chatCompletion(
    config,
    {
      model: config.model,
      messages: [
        { role: "system", content: REGION_REFINE_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2048,
    },
    signal,
  );

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 返回了空响应");

  const jsonStr = content.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/g, "").trim();
  try {
    const parsed = JSON.parse(jsonStr) as AiRegionRefinement;
    return {
      description: parsed.description || "",
      suggestedName: parsed.suggestedName,
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
      keyPapers: Array.isArray(parsed.keyPapers) ? parsed.keyPapers : [],
      distinction: parsed.distinction || "",
    };
  } catch {
    return {
      description: content,
      themes: [],
      keyPapers: [],
      distinction: "",
    };
  }
}