import assert from "node:assert/strict";
import {
  buildInvestigationReport,
  canExportReport,
  investigationReportFileName,
} from "../components/investigation-report";
import type { PublicSession } from "../lib/types";

function session(patch: Partial<PublicSession> = {}): PublicSession {
  return {
    incidentId: "qber-rise-keyrate-drop",
    phase: "idle",
    phaseTrail: ["idle"],
    incident: {
      id: "qber-rise-keyrate-drop",
      title: "QBER 上升且筛选后密钥率下降",
      disclaimer: "合成演练数据。不是真实设备，也不是现网链路。",
      severity: "sev-2",
      openedAt: "2026-10-24T02:40:00Z",
      timeWindow: { from: "2026-10-24T00:00:00Z", to: "2026-10-24T03:00:00Z" },
      nodes: { alice: "NODE-A-HZ-04", bob: "NODE-B-SH-11", linkId: "LN-17" },
      symptoms: ["QBER 在大约 80 分钟内从 1.8% 升到 6.4%"],
      maintenanceWindowSummary: "变更单 CHG-4418：偏振控制器固件。",
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
  body: "QBER 1.8% → 6.4%\n密钥率 12.4 → 3.1 kbps",
};

const diagnostic = {
  evidenceId: "ev-diag",
  sourceTool: "run_diagnostic_test",
  evidenceClass: "diagnostic" as const,
  title: "偏振控制器自检",
  body: "残余基矢角超出规格。",
};

const active = {
  id: "h-active",
  title: "信道损耗待核对",
  status: "active" as const,
  rationale: "采样偏离，还不能下结论。",
  supportingEvidenceIds: ["ev-telemetry"],
};

const priority = {
  id: "h-priority",
  title: "偏振控制器",
  status: "priority" as const,
  rationale: "维护窗口之后 QBER 抬升。",
  supportingEvidenceIds: ["ev-telemetry", "ev-missing"],
};

const excluded = {
  id: "h-excluded",
  title: "探测器暗计数",
  status: "excluded" as const,
  rationale: "日志没有对应尖峰。",
  supportingEvidenceIds: [],
};

const empty = session();
assert.equal(canExportReport(empty), false);
assert.equal(canExportReport(session({ evidence: [evidence] })), true);
assert.equal(canExportReport(session({ hypotheses: [active] })), true);
assert.equal(investigationReportFileName(session({ incidentId: "QBER Rise/Drop" })), "investigation-report-qber-rise-drop.md");

const updated = session({
  phase: "awaiting_steer",
  phaseTrail: ["idle", "ingesting", "investigating", "awaiting_steer", "testing", "updating", "awaiting_steer"],
  evidence: [evidence, diagnostic],
  hypotheses: [excluded, active, priority],
  trace: [
    {
      id: "t1",
      at: "2026-10-25T00:00:01Z",
      toolName: "query_telemetry",
      input: { incidentId: "qber-rise-keyrate-drop", metric: "both" },
      status: "ok",
      output: { marker: "ONLY_IN_TOOL_OUTPUT" },
    },
    {
      id: "t2",
      at: "2026-10-25T00:00:04Z",
      toolName: "run_diagnostic_test",
      input: { testId: "pol-controller-basis-check" },
      status: "error",
      error: "HITL_GATE: refused",
      output: { marker: "ONLY_IN_FAILED_OUTPUT" },
    },
    {
      id: "t3",
      at: "2026-10-25T00:00:09Z",
      toolName: "run_diagnostic_test",
      input: { testId: "pol-controller-basis-check" },
      status: "ok",
      output: { marker: "ONLY_IN_DIAGNOSTIC_OUTPUT" },
    },
  ],
  steering: [
    { id: "s1", action: "exclude", hypothesisId: "h-excluded", at: "2026-10-25T00:00:02Z" },
    { id: "s2", action: "prioritize", hypothesisId: "h-priority", at: "2026-10-25T00:00:03Z" },
    { id: "s3", action: "request_evidence", evidenceClass: "logs", at: "2026-10-25T00:00:05Z" },
    { id: "s4", action: "exclude", hypothesisId: "missing-h", at: "2026-10-25T00:00:06Z" },
  ],
  proposal: null,
  approval: null,
});

const handoff = buildInvestigationReport(updated, { generatedAt: "2026-10-25T01:00:00Z" });
assert.match(handoff, /^# 调查报告/);
assert.match(handoff, /QBER 上升且筛选后密钥率下降/);
assert.match(handoff, /合成演练数据/);
assert.match(handoff, /不是真实设备/);
assert.match(handoff, /时间窗：10-24 00:00:00Z – 10-24 03:00:00Z/);
assert.match(handoff, /LN-17（NODE-A-HZ-04 → NODE-B-SH-11）/);
assert.match(handoff, /CHG-4418/);
assert.match(handoff, /QBER 在大约 80 分钟内从 1.8% 升到 6.4%/);
assert.match(handoff, /假设已更新/);
assert.match(handoff, /不会自动修复/);
assert.match(handoff, /当前阶段：等待转向/);
assert.match(handoff, /经过：空闲 → 装载 → 调查 → 等待转向 → 测试中 → 更新假设 → 等待转向/);
for (const heading of ["## 事件摘要", "## 阶段", "## 假设", "## 转向", "## 诊断", "## 证据要点", "## 工具轨迹", "## 说明"]) {
  assert.match(handoff, new RegExp(heading));
}
const priorityAt = handoff.indexOf("### 偏振控制器");
const activeAt = handoff.indexOf("### 信道损耗待核对");
const excludedAt = handoff.indexOf("### 探测器暗计数");
assert.ok(priorityAt >= 0 && activeAt > priorityAt && excludedAt > activeAt);
assert.match(handoff, /状态：优先/);
assert.match(handoff, /状态：调查中/);
assert.match(handoff, /状态：已排除/);
assert.match(handoff, /维护窗口之后 QBER 抬升/);
assert.match(handoff, /支撑证据：遥测窗口、ev-missing（未出现在证据板）/);
assert.match(handoff, /支撑证据：无/);
assert.match(handoff, /排除「探测器暗计数」/);
assert.match(handoff, /优先调查「偏振控制器」/);
assert.match(handoff, /请求日志证据/);
assert.match(handoff, /排除「missing-h」/);
assert.match(handoff, /诊断已经执行，当前没有新的待批提案/);
assert.match(handoff, /已执行：偏振控制器基矢残差（pol-controller-basis-check）/);
assert.match(handoff, /编号：ev-telemetry/);
assert.doesNotMatch(handoff, /尚未批准/);
assert.match(handoff, /### 遥测 · 遥测窗口/);
assert.match(handoff, /QBER 1\.8% → 6\.4%/);
assert.match(handoff, /### 诊断 · 偏振控制器自检/);
assert.match(handoff, /残余基矢角超出规格/);
assert.match(handoff, /共 3 次，成功 2，失败 1/);
assert.match(handoff, /遥测 · 成功 · 事件 qber-rise-keyrate-drop · 指标 both/);
assert.match(handoff, /诊断测试 · 失败 · 测试 pol-controller-basis-check/);
assert.match(handoff, /HITL_GATE: refused/);
assert.match(handoff, /不是外部工单系统里的单据/);
assert.equal(handoff.includes("ONLY_IN_TOOL_OUTPUT"), false);
assert.equal(handoff.includes("ONLY_IN_FAILED_OUTPUT"), false);
assert.equal(handoff.includes("ONLY_IN_DIAGNOSTIC_OUTPUT"), false);
assert.equal(handoff.includes("rootCause"), false);
assert.equal(handoff.includes("oracle"), false);
assert.equal(handoff.includes("leakSentinel"), false);
assert.equal(handoff.endsWith("\n"), true);

const proposed = buildInvestigationReport(
  session({
    phase: "awaiting_test_approval",
    phaseTrail: ["idle", "awaiting_test_approval"],
    hypotheses: [active],
    evidence: [evidence],
    proposal: { testId: "pol-controller-basis-check", reason: "核对基矢。" },
  }),
  { generatedAt: "2026-10-25T01:00:00Z" },
);
assert.match(proposed, /等待人工批准/);
assert.match(proposed, /提案：偏振控制器基矢残差（pol-controller-basis-check）/);
assert.match(proposed, /理由：核对基矢。/);

const approved = buildInvestigationReport(
  session({
    phase: "awaiting_steer",
    phaseTrail: ["idle", "awaiting_steer"],
    hypotheses: [{ ...priority, supportingEvidenceIds: ["ev-telemetry"] }],
    evidence: [evidence],
    approval: { testId: "pol-controller-basis-check", approvedAt: "2026-10-25T00:00:03Z" },
    proposal: { testId: "pol-controller-basis-check", reason: "核对基矢。" },
  }),
  { generatedAt: "2026-10-25T01:00:00Z" },
);
assert.match(approved, /已批准「偏振控制器基矢残差」/);
assert.match(approved, /10-25 00:00:03Z 批准/);
assert.match(approved, /下一次调查运行才会执行这项诊断/);

const concluded = buildInvestigationReport(
  session({
    ...updated,
    phase: "concluded",
    phaseTrail: [...updated.phaseTrail, "concluded"],
  }),
  { generatedAt: "2026-10-25T01:00:00Z" },
);
assert.match(concluded, /当前阶段：已结束/);
assert.match(concluded, /本次调查已结束/);
assert.doesNotMatch(concluded, /假设已更新/);

const failed = buildInvestigationReport(
  session({
    phase: "error",
    phaseTrail: ["idle", "error"],
    evidence: [evidence],
    error: "缺少密钥",
  }),
  { generatedAt: "2026-10-25T01:00:00Z" },
);
assert.match(failed, /调查停在错误。缺少密钥/);
assert.match(failed, /还没有假设/);
assert.match(failed, /还没有转向/);
assert.match(failed, /这一会话还没有工具调用/);

const same = buildInvestigationReport(updated, { generatedAt: "2026-10-25T01:00:00Z" });
assert.equal(same, handoff);

console.log("report smoke ok");
