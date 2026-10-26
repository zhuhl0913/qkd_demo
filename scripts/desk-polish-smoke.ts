import assert from "node:assert/strict";
import { carryDemoSteer, DEMO_STEP_MS, demoOpening } from "../components/demo-playback";
import { buildInvestigationHandoffJson, buildInvestigationReport } from "../components/investigation-report";
import { interpretOperatorNote } from "../components/operator-note";
import { demoRemainingMs, formatEta, liveRemainingMs, postureCopy } from "../components/run-eta";
import { runInvestigation } from "../lib/run-investigation";
import { getSession, resetSession } from "../lib/session-store";

async function main() {
assert.equal(formatEta(4_000), "约还要 4s");
assert.equal(formatEta(12_000), "约还要 15s");
assert.equal(formatEta(0), "预计已到，仍在进行");
assert.equal(liveRemainingMs("investigating", 0), 45_000);
assert.equal(liveRemainingMs("investigating", 50_000), 0);
assert.equal(liveRemainingMs("idle", 0), null);
assert.equal(demoRemainingMs(7, 1, 0), 6 * DEMO_STEP_MS);
assert.equal(demoRemainingMs(7, 7, 0), 0);
assert.equal(postureCopy({ pending: true, paused: false, phase: "investigating", focus: "wait" }), "代理进行中");
assert.equal(postureCopy({ pending: false, paused: true, phase: "investigating", focus: "wait" }), "你已接管");
assert.equal(postureCopy({ pending: false, paused: false, phase: "awaiting_test_approval", focus: "approve" }), "等待你批准");

const base = demoOpening(
  {
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
    diagnosticCatalog: [],
    provider: {
      provider: "openai",
      modelId: "stand-in",
      openaiApi: "chat",
      baseURL: null,
      configured: false,
    },
  },
  Date.parse("2026-10-24T02:41:00Z"),
);
const withHypotheses = base.find((frame) => frame.hypotheses.length > 0);
assert.ok(withHypotheses);
if (!withHypotheses) throw new Error("opening did not reach hypotheses");
const steered = {
  ...withHypotheses,
  hypotheses: withHypotheses.hypotheses.map((item) =>
    item.id === "h-loss" ? { ...item, status: "excluded" as const } : item,
  ),
  steering: [
    { id: "steer-1", action: "exclude" as const, hypothesisId: "h-loss", at: "2026-10-24T02:42:00Z" },
  ],
};
const carried = carryDemoSteer(base.at(-1)!, steered);
assert.equal(carried.hypotheses.find((item) => item.id === "h-loss")?.status, "excluded");
assert.equal(carried.phase, "awaiting_test_approval");

const noted = interpretOperatorNote("排除", withHypotheses, "h-loss");
assert.equal(noted?.effect, "exclude");
assert.equal(noted?.hypothesisId, "h-loss");
assert.equal(interpretOperatorNote("看日志", withHypotheses, null)?.evidenceClass, "logs");
assert.equal(interpretOperatorNote("先看一眼现场", withHypotheses, null)?.effect, "note");

const handoff = buildInvestigationReport(withHypotheses, {
  generatedAt: "2026-10-24T02:50:00Z",
  notes: [
    {
      id: "note-1",
      at: "2026-10-24T02:48:00Z",
      text: "排除",
      effect: "exclude",
      detail: "已排除这条假设。",
    },
  ],
});
assert.match(handoff, /^# 调查报告/);
assert.match(handoff, /交接稿/);
assert.match(handoff, /\+0s/);
assert.match(handoff, /## 接下来/);
assert.match(handoff, /## 操作备注/);
assert.match(handoff, /不触发修复/);
const json = buildInvestigationHandoffJson(withHypotheses, { generatedAt: "2026-10-24T02:50:00Z" });
assert.match(json, /"kind": "investigation-handoff"/);
assert.equal(json.includes("rootCause"), false);
assert.equal(json.includes("leakSentinel"), false);
assert.equal(json.includes(["hidden", "json"].join(".")), false);

resetSession();
const controller = new AbortController();
controller.abort();
const pausedRun = await runInvestigation(undefined, { signal: controller.signal });
assert.equal(pausedRun.ok, false);
if (!pausedRun.ok) assert.equal(pausedRun.error, "已暂停。");
assert.equal(getSession().phase, "idle");
assert.equal(getSession().error, null);

console.log("desk polish smoke ok");
}

void main();
