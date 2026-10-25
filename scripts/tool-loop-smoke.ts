import assert from "node:assert/strict";
import type { LanguageModel } from "ai";
import { buildModelVisibleContext } from "../lib/model-context";
import {
  planRequiredTools,
  readApprovedTestId,
  repairInvestigationText,
  sanitizeInvestigationObject,
} from "../lib/investigation-loop";
import { loadPublicIncident } from "../lib/public-fixture";
import { runInvestigation } from "../lib/run-investigation";
import {
  approveDiagnostic,
  getSession,
  resetSession,
} from "../lib/session-store";
import { DEFAULT_INCIDENT_ID, ENVIRONMENT_TOOL_NAMES } from "../lib/types";

type SeenCall = {
  responseFormat: string;
  toolChoice: string;
  toolCount: number;
  maxOutputTokens?: number;
  enableThinking: unknown;
};

type FinalAnswer = "json-text" | "reasoning-loose" | "empty";

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
 */
function createCompatibleProvider(
  finalTestId: string,
  finalAnswer: FinalAnswer = "json-text",
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

function assertRealTrace() {
  const session = getSession();
  const okTrace = session.trace.filter((event) => event.status === "ok");
  assert.ok(okTrace.length >= 2, `expected at least 2 tool calls, got ${okTrace.length}`);
  assert.ok(session.evidence.length >= 1, "expected at least one evidence item");
  for (const event of okTrace) {
    assert.ok(
      (ENVIRONMENT_TOOL_NAMES as readonly string[]).includes(event.toolName),
      `unexpected tool ${event.toolName}`,
    );
    assert.match(event.id, /^mock-/);
    const output = event.output as { evidence?: { evidenceId?: string; body?: string } };
    assert.equal(typeof output?.evidence?.evidenceId, "string");
    assert.ok((output.evidence?.body?.length ?? 0) > 0);
  }
  const proposalId = session.proposal?.testId ?? null;
  if (proposalId) {
    assert.equal(
      (ENVIRONMENT_TOOL_NAMES as readonly string[]).includes(proposalId),
      false,
      `tool name was stored as testId: ${proposalId}`,
    );
    assert.match(
      proposalId,
      /^(pol-controller-basis-check|channel-loss-budget|detector-dark-count|clock-sync-offset)$/,
    );
  }
}

async function main() {
  const bad = sanitizeInvestigationObject({
    hypotheses: [{ id: "h" }],
    proposedDiagnostic: { testId: "query_telemetry", reason: "把工具名当成了测试" },
  }) as { proposedDiagnostic: unknown };
  assert.equal(bad.proposedDiagnostic, null);

  const kept = sanitizeInvestigationObject({
    proposedDiagnostic: { testId: "channel-loss-budget", reason: "目录内" },
  }) as { proposedDiagnostic: { testId: string } };
  assert.equal(kept.proposedDiagnostic.testId, "channel-loss-budget");

  const repaired = repairInvestigationText([
    'We{"hypotheses":[{"标题":"探测器暗计数","status":"排除","依据":"日志没有支持","evidenceIds":["ev-1"]}],"proposedDiagnostic":{"testId":"query_logs","reason":"工具名"}}',
  ]);
  assert.ok(repaired);
  const repairedObject = JSON.parse(repaired) as {
    hypotheses: Array<{ title: string; status: string }>;
    proposedDiagnostic: unknown;
  };
  assert.equal(repairedObject.hypotheses[0]?.title, "探测器暗计数");
  assert.equal(repairedObject.hypotheses[0]?.status, "excluded");
  assert.equal(repairedObject.proposedDiagnostic, null);
  assert.equal(repairInvestigationText(["没有假设"]), null);

  const visible = buildModelVisibleContext({
    incident: loadPublicIncident(),
    evidence: [],
    hypotheses: [],
    steering: [],
    approvedTestId: null,
  });
  const prompt = [
    { role: "system", content: visible.instructions },
    { role: "user", content: [{ type: "text", text: visible.prompt }] },
  ];
  assert.deepEqual(planRequiredTools(prompt), [
    "query_telemetry",
    "query_logs",
    "list_available_diagnostics",
  ]);
  assert.equal(visible.instructions.includes("query_telemetry"), true);
  assert.equal(visible.instructions.includes("channel-loss-budget"), true);
  assert.equal(visible.prompt.includes("allowedDiagnosticTestIds"), true);
  assert.equal(readApprovedTestId(prompt), null);

  const steered = buildModelVisibleContext({
    incident: loadPublicIncident(),
    evidence: [],
    hypotheses: [],
    steering: [
      {
        id: "steer-1",
        action: "request_evidence",
        evidenceClass: "maintenance",
        at: "2026-10-24T03:00:00Z",
      },
    ],
    approvedTestId: "pol-controller-basis-check",
  });
  const steeredPrompt = [{ role: "user", content: [{ type: "text", text: steered.prompt }] }];
  assert.deepEqual(planRequiredTools(steeredPrompt), [
    "query_maintenance_context",
    "query_logs",
    "list_available_diagnostics",
    "run_diagnostic_test",
  ]);
  assert.equal(readApprovedTestId(steeredPrompt), "pol-controller-basis-check");

  const previousProvider = process.env.AI_PROVIDER;
  const previousProviderName = process.env.AI_PROVIDER_NAME;
  process.env.AI_PROVIDER = "openai";
  try {
  resetSession();
  const first = createCompatibleProvider("channel-loss-budget");
  const firstRun = await runInvestigation(first.model);
  assert.equal(firstRun.ok, true, !firstRun.ok ? firstRun.error : "");
  assertRealTrace();
  assert.equal(getSession().proposal?.testId, "channel-loss-budget");
  assert.equal(
    getSession().trace.some((event) => event.toolName === "run_diagnostic_test"),
    false,
  );
  assert.ok(first.calls.filter((call) => call.toolChoice !== "auto" && call.responseFormat !== "json").length >= 2);
  assert.equal(
    first.calls.some((call) => call.responseFormat === "json" && call.toolCount > 0),
    false,
    "JSON response format was sent together with tools",
  );
  assert.equal(first.calls.at(-1)?.responseFormat, "json");

  resetSession();
  const invented = createCompatibleProvider("query_telemetry");
  const inventedRun = await runInvestigation(invented.model);
  assert.equal(inventedRun.ok, true, !inventedRun.ok ? inventedRun.error : "");
  assertRealTrace();
  assert.equal(getSession().proposal, null);

  resetSession();
  approveDiagnostic("pol-controller-basis-check");
  const approved = createCompatibleProvider("detector-dark-count");
  const approvedRun = await runInvestigation(approved.model);
  assert.equal(approvedRun.ok, true, !approvedRun.ok ? approvedRun.error : "");
  assertRealTrace();
  const diagnostic = getSession().trace.filter(
    (event) => event.toolName === "run_diagnostic_test" && event.status === "ok",
  );
  assert.equal(diagnostic.length, 1);
  assert.equal(
    (diagnostic[0]?.input as { testId?: string }).testId,
    "pol-controller-basis-check",
  );
  assert.ok(getSession().evidence.some((item) => item.evidenceClass === "diagnostic" && item.body.length > 0));
  assert.equal(getSession().approval, null);
  assert.equal(getSession().phase, "awaiting_steer");

  process.env.AI_PROVIDER = "openai-compatible";
  process.env.AI_PROVIDER_NAME = "openai-compatible";

  resetSession();
  const reasoning = createCompatibleProvider("query_telemetry", "reasoning-loose");
  const reasoningRun = await runInvestigation(reasoning.model);
  assert.equal(reasoningRun.ok, true, !reasoningRun.ok ? reasoningRun.error : "");
  assertRealTrace();
  assert.ok(getSession().hypotheses.length >= 1);
  assert.equal(getSession().hypotheses[0]?.title, "信道损耗待核对");
  assert.equal(getSession().hypotheses[0]?.status, "priority");
  assert.deepEqual(getSession().hypotheses[0]?.supportingEvidenceIds, ["ev-telemetry-qber-keyrate"]);
  assert.equal(getSession().proposal, null);
  assert.equal(getSession().phase, "awaiting_steer");
  assert.equal(
    reasoning.calls.some((call) => call.responseFormat === "json"),
    false,
    "openai-compatible final step must not send response_format",
  );
  const toolSteps = reasoning.calls.slice(0, -1);
  assert.ok(toolSteps.length >= 2);
  assert.ok(toolSteps.every((call) => call.responseFormat === "text" && call.toolChoice !== "auto" && call.toolChoice !== "none"));
  assert.ok(toolSteps.every((call) => call.enableThinking === undefined));
  const last = reasoning.calls.at(-1);
  assert.equal(last?.responseFormat, "text");
  assert.equal(last?.toolChoice, "none");
  assert.ok((last?.toolCount ?? 0) > 0);
  assert.equal(last?.enableThinking, false);
  assert.ok((last?.maxOutputTokens ?? 0) >= 4096);

  resetSession();
  const catalog = createCompatibleProvider("channel-loss-budget", "reasoning-loose");
  const catalogRun = await runInvestigation(catalog.model);
  assert.equal(catalogRun.ok, true, !catalogRun.ok ? catalogRun.error : "");
  assertRealTrace();
  assert.ok(getSession().hypotheses.length >= 1);
  assert.equal(getSession().proposal?.testId, "channel-loss-budget");
  assert.equal(getSession().phase, "awaiting_test_approval");

  resetSession();
  const empty = createCompatibleProvider("channel-loss-budget", "empty");
  const emptyRun = await runInvestigation(empty.model);
  assert.equal(emptyRun.ok, false);
  assert.equal(getSession().hypotheses.length, 0);
  assert.equal(getSession().phase, "error");

  console.log("tool loop smoke: ok");
  } finally {
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
    if (previousProviderName === undefined) delete process.env.AI_PROVIDER_NAME;
    else process.env.AI_PROVIDER_NAME = previousProviderName;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : "tool loop smoke failed";
  console.error(message);
  process.exit(1);
});
