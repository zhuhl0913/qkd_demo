import assert from "node:assert/strict";
import { changeChips, deskMoment, diffSessions, legLabel, loopSteps } from "../components/desk-loop";
import { PHASE_LABELS, PHASES, type PublicSession } from "../lib/types";

function session(patch: Partial<PublicSession> = {}): PublicSession {
  return {
    incidentId: "qber-rise-keyrate-drop",
    phase: "idle",
    phaseTrail: ["idle"],
    incident: {
      id: "qber-rise-keyrate-drop",
      title: "QBER 上升且筛选后密钥率下降",
      disclaimer: "合成演练数据。",
      severity: "sev-2",
      openedAt: "2026-10-24T02:40:00Z",
      timeWindow: { from: "2026-10-24T00:00:00Z", to: "2026-10-24T03:00:00Z" },
      nodes: { alice: "NODE-A-HZ-04", bob: "NODE-B-SH-11", linkId: "LN-17" },
      symptoms: ["QBER 上升"],
      maintenanceWindowSummary: "CHG-4418",
    },
    evidence: [],
    hypotheses: [],
    trace: [],
    steering: [],
    proposal: null,
    approval: null,
    error: null,
    diagnosticCatalog: [
      {
        testId: "pol-controller-basis-check",
        title: "偏振控制器基矢残差",
        measures: "读取残余基矢角。",
      },
    ],
    provider: {
      provider: "openai",
      modelId: "stand-in",
      openaiApi: "chat",
      baseURL: null,
      configured: false,
    },
    ...patch,
  };
}

const evidence = {
  evidenceId: "ev-telemetry",
  sourceTool: "query_telemetry",
  evidenceClass: "telemetry" as const,
  title: "遥测窗口",
  body: "QBER 上升",
};

const hypothesis = {
  id: "h1",
  title: "偏振控制器",
  status: "active" as const,
  rationale: "遥测在维护之后偏离。",
  supportingEvidenceIds: ["ev-telemetry"],
};

const firstRun = session({
  phase: "awaiting_test_approval",
  phaseTrail: ["idle", "ingesting", "investigating", "updating", "proposing_test", "awaiting_test_approval"],
  evidence: [evidence],
  hypotheses: [hypothesis],
  trace: [
    {
      id: "t1",
      at: "2026-10-25T00:00:01Z",
      toolName: "query_telemetry",
      input: { incidentId: "qber-rise-keyrate-drop" },
      status: "ok",
      output: { evidence },
    },
  ],
  proposal: { testId: "pol-controller-basis-check", reason: "核对基矢。" },
});

const idle = deskMoment(session(), false);
assert.equal(idle.focus, "run");
assert.equal(idle.title, "运行调查");
assert.equal(loopSteps(session(), false)[0]?.mark, "current");
assert.equal(loopSteps(session(), false)[0]?.label, "查证");

const pending = deskMoment(session(), true);
assert.equal(pending.focus, "wait");
assert.equal(pending.title, "调查进行中");
assert.equal(pending.detail, "正在接上这一轮。");
assert.doesNotMatch(pending.detail, /空闲/);

const midRun = session({
  phase: "investigating",
  phaseTrail: ["idle", "ingesting", "investigating"],
  evidence: [evidence],
  trace: [
    {
      id: "t-mid",
      at: "2026-10-25T00:00:01Z",
      toolName: "query_telemetry",
      input: { incidentId: "qber-rise-keyrate-drop" },
      status: "ok",
      output: { evidence },
    },
  ],
});
const midMoment = deskMoment(midRun, true);
assert.equal(midMoment.focus, "wait");
assert.match(midMoment.detail, /调查/);
assert.equal(PHASE_LABELS[midRun.phase], "调查");
assert.equal(loopSteps(midRun, true).find((step) => step.id === "query")?.mark, "current");
assert.equal(loopSteps(midRun, true).find((step) => step.id === "query")?.done, true);

const midUpdate = session({
  ...midRun,
  phase: "updating",
  phaseTrail: ["idle", "ingesting", "investigating", "updating"],
});
assert.match(deskMoment(midUpdate, true).detail, /更新假设/);
assert.equal(loopSteps(midUpdate, true).find((step) => step.id === "query")?.mark, "done");
assert.equal(loopSteps(midUpdate, true).find((step) => step.id === "hypothesize")?.mark, "current");

const waitingApproval = deskMoment(firstRun, false);
assert.equal(waitingApproval.focus, "approve");
assert.equal(waitingApproval.title, "批准诊断");
assert.match(waitingApproval.detail, /提案/);
assert.deepEqual(
  loopSteps(firstRun, false).map((step) => [step.label, step.mark, step.done]),
  [
    ["查证", "done", true],
    ["假设", "done", true],
    ["转向", "upcoming", false],
    ["批准", "current", false],
    ["新证", "upcoming", false],
    ["更新", "upcoming", false],
  ],
);

const steered = session({
  ...firstRun,
  steering: [
    { id: "s1", action: "prioritize", hypothesisId: "h1", at: "2026-10-25T00:00:02Z" },
  ],
  hypotheses: [{ ...hypothesis, status: "priority" }],
});
const steeredNoProposal = session({
  phase: "awaiting_steer",
  phaseTrail: ["idle", "awaiting_steer"],
  evidence: [evidence],
  hypotheses: [{ ...hypothesis, status: "priority" }],
  steering: [{ id: "s1", action: "prioritize", hypothesisId: "h1", at: "2026-10-25T00:00:02Z" }],
});
assert.equal(deskMoment(steeredNoProposal, false).focus, "run");
assert.equal(loopSteps(steeredNoProposal, false).find((step) => step.id === "query")?.mark, "current");
assert.equal(loopSteps(steeredNoProposal, false).find((step) => step.id === "approve")?.mark, "upcoming");

assert.equal(deskMoment(steered, false).focus, "approve");
assert.equal(loopSteps(steered, false).find((step) => step.id === "steer")?.done, true);

const approved = session({
  ...steered,
  approval: { testId: "pol-controller-basis-check", approvedAt: "2026-10-25T00:00:03Z" },
});
const rerun = deskMoment(approved, false);
assert.equal(rerun.focus, "rerun");
assert.match(rerun.detail, /已批准/);
assert.equal(loopSteps(approved, false).find((step) => step.id === "approve")?.done, true);
assert.equal(loopSteps(approved, false).find((step) => step.id === "fresh")?.mark, "current");

const approvedEarly = session({
  ...firstRun,
  approval: { testId: "pol-controller-basis-check", approvedAt: "2026-10-25T00:00:03Z" },
});
assert.equal(deskMoment(approvedEarly, false).focus, "rerun");
assert.equal(loopSteps(approvedEarly, false).find((step) => step.id === "fresh")?.mark, "current");
assert.equal(loopSteps(approvedEarly, false).find((step) => step.id === "steer")?.done, false);
assert.equal(loopSteps(approvedEarly, false).find((step) => step.id === "approve")?.done, true);

const diagnostic = {
  evidenceId: "ev-diag",
  sourceTool: "run_diagnostic_test",
  evidenceClass: "diagnostic" as const,
  title: "偏振控制器自检",
  body: "残余基矢角超出规格。",
};
const updated = session({
  phase: "awaiting_steer",
  phaseTrail: [
    ...approved.phaseTrail,
    "ingesting",
    "testing",
    "updating",
    "awaiting_steer",
  ],
  evidence: [...approved.evidence, diagnostic],
  hypotheses: [{ ...hypothesis, status: "priority", rationale: "自检超出规格。", supportingEvidenceIds: ["ev-telemetry", "ev-diag"] }],
  trace: [
    ...approved.trace,
    {
      id: "t2",
      at: "2026-10-25T00:00:04Z",
      toolName: "run_diagnostic_test",
      input: { testId: "pol-controller-basis-check" },
      status: "ok",
      output: { evidence: diagnostic },
    },
  ],
  steering: approved.steering,
  proposal: null,
  approval: null,
});
const done = deskMoment(updated, false);
assert.equal(done.focus, "done");
assert.match(done.detail, /诊断证据/);
assert.equal(loopSteps(updated, false).every((step) => step.done), true);
assert.equal(loopSteps(updated, false).find((step) => step.id === "update")?.mark, "current");

const diff = diffSessions(approved, updated);
assert.ok(diff);
assert.deepEqual(diff?.evidenceIds, ["ev-diag"]);
assert.deepEqual(diff?.traceIds, ["t2"]);
assert.deepEqual(diff?.textChanges, ["h1"]);
assert.deepEqual(changeChips(diff!), ["新工具调用 1", "新证据 1", "依据更新 1"]);

const statusOnly = diffSessions(firstRun, steered);
assert.deepEqual(statusOnly?.statusChanges.h1, { from: "active", to: "priority" });
assert.deepEqual(statusOnly?.steerIds, ["s1"]);
assert.deepEqual(changeChips(statusOnly!), ["状态变化 1", "新转向 1"]);

assert.equal(diffSessions(updated, session()), null);
assert.equal(diffSessions(null, firstRun), null);

assert.equal(
  legLabel(firstRun.phaseTrail),
  "装载 → 调查 → 更新假设 → 提出测试 → 等待批准",
);

const failed = deskMoment(session({ phase: "error", error: "缺少密钥", phaseTrail: ["idle", "error"] }), false);
assert.equal(failed.focus, "run");
assert.match(failed.detail, /缺少密钥/);

for (const phase of PHASES) {
  assert.equal(typeof PHASE_LABELS[phase], "string");
}

console.log("desk loop smoke ok");
