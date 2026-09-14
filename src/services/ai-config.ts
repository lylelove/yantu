/**
 * AI 配置持久化。
 *
 * 配置存储在 localStorage 中，与存档分开，因为配置不属于用户文献数据。
 * API Key 不经过任何第三方存储，仅留存在用户本地浏览器中。
 */

import { AI_PROVIDERS, type AiConfig, DEFAULT_AI_CONFIG } from "./ai-types";

const CONFIG_KEY = "yantu.ai.config.v1";

/**
 * 读取已保存的 AI 配置，如果没有则返回默认值。
 */
export function readAiConfig(): AiConfig {
  if (typeof localStorage === "undefined") return { ...DEFAULT_AI_CONFIG };
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_AI_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      providerId: typeof parsed.providerId === "string" ? parsed.providerId : DEFAULT_AI_CONFIG.providerId,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

/**
 * 保存 AI 配置到 localStorage。
 */
export function persistAiConfig(config: AiConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // 静默失败，当前会话仍然可用
  }
}

/**
 * 根据 providerId 获取提供商预设信息。
 */
export function getProviderInfo(providerId: string) {
  return AI_PROVIDERS.find((p) => p.id === providerId);
}

/**
 * 验证配置是否可用于发起 API 调用。
 */
export function isConfigValid(config: AiConfig): boolean {
  if (!config.enabled) return false;
  if (!config.apiKey.trim()) return false;
  if (!config.baseUrl.trim()) return false;
  if (!config.model.trim()) return false;
  return true;
}