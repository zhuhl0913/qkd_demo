import assert from "node:assert/strict";
import type { LanguageModel } from "ai";
import { buildModelVisibleContext } from "../lib/model-context";
import {
  planRequiredTools,
  readApprovedTestId,
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
};

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

/**
 * Stand-in for an OpenAI-compatible provider: a JSON response format is
 * answered immediately, and tools are ignored. Tool calls happen only when
 * the loop asks for one specific tool without that format.
 */
function createCompatibleProvider(finalTestId: string): { model: LanguageModel; calls: SeenCall[] } {
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
    }) {
      const responseFormat = params.responseFormat?.type ?? "text";
      const toolChoice =
        params.toolChoice?.type === "tool"
          ? params.toolChoice.toolName ?? "tool"
          : (params.toolChoice?.type ?? "auto");
      calls.push({
        responseFormat,
        toolChoice,
        toolCount: params.tools?.length ?? 0,
      });

      if (responseFormat === "json") {
        const text = JSON.stringify(finalObject(finalTestId));
        return {
          content: [{ type: "text" as const, text }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      }

      const toolName = params.toolChoice?.type === "tool" ? params.toolChoice.toolName : "";
      if (!toolName) {
        throw new Error("compatible provider was not told which tool to call");
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

  console.log("tool loop smoke: ok");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : "tool loop smoke failed";
  console.error(message);
  process.exit(1);
});
