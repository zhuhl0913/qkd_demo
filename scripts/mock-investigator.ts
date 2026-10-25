import type { LanguageModel } from "ai";
import { readApprovedTestId } from "../lib/investigation-loop";
import { DEFAULT_INCIDENT_ID } from "../lib/types";

type SeenCall = {
  responseFormat: string;
  toolChoice: string;
  toolCount: number;
  maxOutputTokens?: number;
  enableThinking: unknown;
};

export type FinalAnswer = "json-text" | "reasoning-loose" | "empty";

const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function finalObject(testId: string) {
  return {
    hypotheses: [
      {
        id: "h-channel",
        title: "信道损耗待核对",
        status: "active",
        rationale: "已经读到采样和日志，还不能下结论。",
        supportingEvidenceIds: ["ev-telemetry-qber-keyrate"],
      },
    ],
    proposedDiagnostic: {
      testId,
      reason: "对照目录里的一项测试。",
    },
  };
}

function looseReasoning(testId: string): string {
  const payload = {
    hypotheses: [
      {
        标题: "信道损耗待核对",
        status: "优先",
        依据: "已经读到采样和日志，还不能下结论。",
        evidence: [{ evidenceId: "ev-telemetry-qber-keyrate" }],
      },
    ],
    proposed_diagnostic: {
      test_id: testId,
      reason: "对照目录里的一项测试。",
    },
  };
  const fenced = JSON.stringify(payload).replace("qber-keyrate\"}]", "qber-keyrate\"},]");
  return `We need to answer.\n\`\`\`json\n${fenced}\n\`\`\``;
}

/**
 * Stand-in for an OpenAI-compatible provider.
 * `json-text` answers a JSON response format immediately.
 * `reasoning-loose` imitates SiliconFlow DeepSeek-V3.2: content is empty and
 * the object sits in reasoning, with a prefix, a fence, and a trailing comma.
 * `empty` returns no object at all.
 * `delayMs` pauses each model call so a stream test can observe earlier events.
 */
export function createCompatibleProvider(
  finalTestId: string,
  finalAnswer: FinalAnswer = "json-text",
  delayMs = 0,
): { model: LanguageModel; calls: SeenCall[] } {
  const calls: SeenCall[] = [];
  let sequence = 0;
  const model = {
    specificationVersion: "v4" as const,
    provider: "mock",
    modelId: "mock-investigator",
    supportedUrls: {},
    async doGenerate(params: {
      prompt: unknown;
      responseFormat?: { type?: string };
      toolChoice?: { type?: string; toolName?: string };
      tools?: unknown[];
      maxOutputTokens?: number;
      providerOptions?: Record<string, { enable_thinking?: unknown } | undefined>;
    }) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const responseFormat = params.responseFormat?.type ?? "text";
      const toolChoice =
        params.toolChoice?.type === "tool"
          ? params.toolChoice.toolName ?? "tool"
          : (params.toolChoice?.type ?? "auto");
      const options = params.providerOptions;
      calls.push({
        responseFormat,
        toolChoice,
        toolCount: params.tools?.length ?? 0,
        maxOutputTokens: params.maxOutputTokens,
        enableThinking:
          options?.["openai-compatible"]?.enable_thinking ?? options?.openaiCompatible?.enable_thinking,
      });

      const toolName = params.toolChoice?.type === "tool" ? params.toolChoice.toolName : "";
      if (!toolName) {
        if (finalAnswer === "empty") {
          return {
            content: [],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
            warnings: [],
          };
        }
        if (finalAnswer === "reasoning-loose") {
          return {
            content: [{ type: "reasoning" as const, text: looseReasoning(finalTestId) }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
            warnings: [],
          };
        }
        if (responseFormat !== "json") {
          throw new Error("compatible provider was not told which tool to call");
        }
        const text = JSON.stringify(finalObject(finalTestId));
        return {
          content: [{ type: "text" as const, text }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      }
      const approved = readApprovedTestId(params.prompt);
      const input =
        toolName === "run_diagnostic_test"
          ? { incidentId: DEFAULT_INCIDENT_ID, testId: approved }
          : toolName === "query_telemetry"
            ? { incidentId: DEFAULT_INCIDENT_ID, metric: "both" }
            : toolName === "query_logs"
              ? { incidentId: DEFAULT_INCIDENT_ID, source: "any", limit: 8 }
              : { incidentId: DEFAULT_INCIDENT_ID };
      sequence += 1;
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `mock-${toolName}-${sequence}`,
            toolName,
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        usage,
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("stream is not used");
    },
  };
  return { model: model as LanguageModel, calls };
}
