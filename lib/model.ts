import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderStatus } from "./types";

export type ModelConfig = {
  provider: string;
  modelId: string;
  apiKey: string;
  baseURL: string | null;
  openaiApi: "responses" | "chat";
  providerName: string;
  supportsStructuredOutputs: boolean;
};

export function readModelConfig(): ModelConfig {
  const provider = (process.env.AI_PROVIDER ?? "openai").trim();
  const modelId = (process.env.AI_MODEL ?? "gpt-4o-mini").trim();
  const apiKey = (process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim();
  const baseURL = (process.env.AI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "").trim() || null;
  const openaiApi = process.env.AI_OPENAI_API === "chat" ? "chat" : "responses";
  const providerName = (process.env.AI_PROVIDER_NAME ?? "openai-compatible").trim();
  const supportsStructuredOutputs = process.env.AI_SUPPORTS_STRUCTURED_OUTPUTS !== "false";
  return {
    provider,
    modelId,
    apiKey,
    baseURL,
    openaiApi,
    providerName,
    supportsStructuredOutputs,
  };
}

export function readProviderStatus(): ProviderStatus {
  const config = readModelConfig();
  return {
    provider: config.provider,
    modelId: config.modelId,
    openaiApi: config.openaiApi,
    baseURL: config.baseURL,
    configured: config.apiKey.length > 0,
  };
}

export function getLanguageModel(): LanguageModel {
  const config = readModelConfig();
  if (!config.apiKey) {
    throw new Error(
      "缺少 AI_API_KEY 或 OPENAI_API_KEY。把 .env.example 复制为 .env.local 并填入密钥。本次没有调用工具。",
    );
  }

  if (config.provider === "openai-compatible") {
    if (!config.baseURL) {
      throw new Error("AI_PROVIDER=openai-compatible 时必须设置 AI_BASE_URL。本次没有调用工具。");
    }
    const compatible = createOpenAICompatible({
      name: config.providerName,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      supportsStructuredOutputs: config.supportsStructuredOutputs,
    });
    return compatible(config.modelId);
  }

  if (config.provider === "openai") {
    const openai = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? undefined,
    });
    return config.openaiApi === "chat" ? openai.chat(config.modelId) : openai(config.modelId);
  }

  throw new Error(
    `未知 AI_PROVIDER "${config.provider}"。使用 openai 或 openai-compatible。本次没有调用工具。`,
  );
}
