/**
 * AI 服务配置与类型定义。
 *
 * Yantu 通过 OpenAI 兼容的 API 提供 AI 辅助功能，用户可自由选择
 * 不同的模型提供商（OpenAI、DeepSeek、SiliconFlow、本地模型等）。
 * 配置仅保存在本地，不上传至任何第三方。
 */

/** 已知的 AI 提供商预设 */
export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-3.5-turbo"],
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-14B-Instruct", "Qwen/Qwen2.5-32B-Instruct", "deepseek-ai/DeepSeek-V3", "Pro/Qwen/Qwen2.5-7B-Instruct"],
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
  },
  {
    id: "custom",
    label: "自定义",
    baseUrl: "",
    models: [],
    defaultModel: "",
  },
];

export interface AiProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
}

export interface AiConfig {
  /** 当前选中的提供商 id */
  providerId: string;
  /** API Key */
  apiKey: string;
  /** API 基础地址 */
  baseUrl: string;
  /** 模型名称 */
  model: string;
  /** 是否启用 AI 功能 */
  enabled: boolean;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  providerId: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  enabled: false,
};

/** AI 返回的关系解释 */
export interface AiRelationExplanation {
  /** 关系类型的自然语言描述 */
  summary: string;
  /** 详细解释 */
  detail: string;
  /** 相关引文或依据 */
  evidence: string[];
}

/** AI 请求的 message 格式（兼容 OpenAI Chat API） */
export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** AI Chat Completion 请求体 */
export interface AiChatRequest {
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

/** AI Chat Completion 响应 */
export interface AiChatResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
}

/** AI 生成的区域细化分析 */
export interface AiRegionRefinement {
  /** 区域的整体描述（100-200 字） */
  description: string;
  /** 建议的名称（如果当前名称不合适） */
  suggestedName?: string;
  /** 该区域内的主要研究主题 */
  themes: string[];
  /** 该区域内的关键论文标题（最多 5 篇） */
  keyPapers: string[];
  /** 该区域与其它区域的独特区分点 */
  distinction: string;
}