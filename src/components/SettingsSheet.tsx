import { useEffect, useState } from "react";

import { AI_PROVIDERS, type AiConfig, DEFAULT_AI_CONFIG } from "../services/ai-types";
import { getProviderInfo, isConfigValid, persistAiConfig, readAiConfig } from "../services/ai-config";
import { fetchAiApi } from "../services/ai-proxy-fetch";

/**
 * 设置面板 —— AI 配置。
 *
 * 用户在此配置 AI 提供商、API Key、模型等。
 * 配置仅存储在本地，与文献数据独立。
 */

interface Props {
  onClose: () => void;
}

export default function SettingsSheet({ onClose }: Props) {
  const [config, setConfig] = useState<AiConfig>(() => readAiConfig());
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "fail">("idle");

  useEffect(() => {
    persistAiConfig(config);
  }, [config]);

  const provider = getProviderInfo(config.providerId);
  const valid = isConfigValid(config);

  const updateField = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleProviderChange = (providerId: string) => {
    const info = getProviderInfo(providerId);
    if (info && info.id !== "custom") {
      setConfig((prev) => ({
        ...prev,
        providerId: info.id,
        baseUrl: info.baseUrl,
        model: info.defaultModel,
      }));
    } else {
      setConfig((prev) => ({
        ...prev,
        providerId: "custom",
        baseUrl: "",
        model: "",
      }));
    }
  };

  const testConnection = async () => {
    if (!valid) return;
    setTestStatus("testing");
    try {
      const baseUrl = config.baseUrl.replace(/\/+$/, "");
      const response = await fetchAiApi(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
      if (response.ok) {
        setTestStatus("success");
      } else {
        setTestStatus("fail");
      }
    } catch {
      setTestStatus("fail");
    }
  };

  const resetConfig = () => {
    setConfig({ ...DEFAULT_AI_CONFIG });
    persistAiConfig({ ...DEFAULT_AI_CONFIG });
    setTestStatus("idle");
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet sheet-wide">
        <h2>设置</h2>
        <p>配置 AI 服务。API Key 只保存在你的本地浏览器中，不会上传到任何第三方。</p>

        {/* AI 启用开关 */}
        <div className="settings-section">
          <div className="settings-toggle">
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => updateField("enabled", e.target.checked)}
              />
              <span>启用 AI 功能</span>
            </label>
            <span className="settings-hint">
              开启后可在文献详情页面使用 AI 分析论文关系
            </span>
          </div>
        </div>

        {config.enabled && (
          <>
            {/* 提供商选择 */}
            <div className="settings-section">
              <label className="settings-label">AI 提供商</label>
              <div className="settings-providers">
                {AI_PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`settings-provider-btn${config.providerId === p.id ? " active" : ""}`}
                    onClick={() => handleProviderChange(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* API 地址 */}
            <div className="settings-section">
              <label className="settings-label" htmlFor="settings-base-url">
                API 地址
              </label>
              <input
                id="settings-base-url"
                type="url"
                className="settings-input"
                value={config.baseUrl}
                onChange={(e) => updateField("baseUrl", e.target.value)}
                placeholder={provider?.baseUrl || "https://api.openai.com/v1"}
              />
              <span className="settings-hint">
                兼容 OpenAI 格式的 API 地址，例如 {provider?.baseUrl || "https://api.openai.com/v1"}
              </span>
            </div>

            {/* API Key */}
            <div className="settings-section">
              <label className="settings-label" htmlFor="settings-api-key">
                API Key
              </label>
              <input
                id="settings-api-key"
                type="password"
                className="settings-input"
                value={config.apiKey}
                onChange={(e) => updateField("apiKey", e.target.value)}
                placeholder="sk-..."
              />
              <span className="settings-hint">
                API Key 只存储在本地浏览器中，不会上传到 Yantu 或其他第三方
              </span>
            </div>

            {/* 模型 */}
            <div className="settings-section">
              <label className="settings-label" htmlFor="settings-model">
                模型
              </label>
              {provider && provider.models.length > 0 ? (
                <select
                  id="settings-model"
                  className="settings-select"
                  value={config.model}
                  onChange={(e) => updateField("model", e.target.value)}
                >
                  {provider.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="settings-model"
                  type="text"
                  className="settings-input"
                  value={config.model}
                  onChange={(e) => updateField("model", e.target.value)}
                  placeholder="gpt-4o-mini"
                />
              )}
              <span className="settings-hint">
                选择或输入你想使用的模型名称
              </span>
            </div>

            {/* 测试连接 */}
            <div className="settings-section">
              <div className="settings-actions-row">
                <button
                  type="button"
                  onClick={testConnection}
                  disabled={!valid || testStatus === "testing"}
                >
                  {testStatus === "testing" ? "测试中…" : "测试连接"}
                </button>
                {testStatus === "success" && (
                  <span className="settings-test-ok">连接成功 ✓</span>
                )}
                {testStatus === "fail" && (
                  <span className="settings-test-fail">连接失败，请检查配置</span>
                )}
              </div>
            </div>

            {/* 重置 */}
            <div className="settings-section settings-section-footer">
              <button type="button" className="settings-reset-btn" onClick={resetConfig}>
                重置为默认配置
              </button>
            </div>
          </>
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