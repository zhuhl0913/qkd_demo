import assert from "node:assert/strict";
import { demoApprove, demoContinue, demoEpilogue, demoOpening, demoReject, demoSteer } from "../components/demo-playback";
import type { PublicSession } from "../lib/types";

function session(): PublicSession {
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
      { testId: "pol-controller-basis-check", title: "偏振控制器基矢残差", measures: "读取残余基矢角。" },
    ],
    provider: {
      provider: "openai",
      modelId: "stand-in",
      openaiApi: "chat",
      baseURL: null,
      configured: false,
    },
  };
}

const frames = demoOpening(session(), Date.parse("2026-10-24T02:41:00Z"));
assert.ok(frames.length >= 6);
assert.equal(frames[0]?.phase, "ingesting");
assert.equal(frames.at(-1)?.phase, "awaiting_test_approval");
assert.ok((frames.at(-1)?.trace.length ?? 0) >= 3);
assert.ok((frames.at(-1)?.hypotheses.length ?? 0) >= 2);
assert.ok((frames.at(-1)?.evidence.length ?? 0) >= 2);
assert.equal(frames.at(-1)?.proposal?.testId, "pol-controller-basis-check");
const stamps = (frames.at(-1)?.trace ?? []).map((event) => Date.parse(event.at));
assert.ok(stamps.every((stamp, index) => index === 0 || stamp >= stamps[index - 1]!));

const held = frames.at(-1)!;
const approved = demoApprove(held, held.proposal!.testId, "2026-10-24T02:42:00Z");
assert.equal(approved.phase, "awaiting_test_approval");
assert.equal(approved.approval?.testId, "pol-controller-basis-check");

const steered = demoSteer(approved, {
  action: "exclude",
  hypothesisId: "h-loss",
  at: "2026-10-24T02:42:01Z",
});
assert.equal(steered.hypotheses.find((item) => item.id === "h-loss")?.status, "excluded");

const end = demoEpilogue(steered, Date.parse("2026-10-24T02:41:00Z")).at(-1)!;
assert.equal(end.phase, "awaiting_steer");
assert.equal(end.approval, null);
assert.equal(end.proposal, null);
assert.ok(end.evidence.some((item) => item.evidenceClass === "diagnostic"));
assert.equal(end.hypotheses.find((item) => item.id === "h-loss")?.status, "excluded");
assert.ok(end.hypotheses.find((item) => item.id === "h-pol")?.supportingEvidenceIds.includes("ev-demo-diag"));

const rejected = demoReject(held);
assert.equal(rejected.proposal, null);
assert.equal(rejected.approval, null);
assert.equal(rejected.phase, "awaiting_steer");

const catalog = [
  { testId: "pol-controller-basis-check", title: "偏振控制器基矢残差", measures: "读取残余基矢角。" },
  { testId: "channel-loss-budget", title: "信道损耗预算", measures: "核对分段损耗。" },
  { testId: "detector-dark-count", title: "探测器暗计数", measures: "读取暗计数。" },
  { testId: "clock-sync-offset", title: "时钟同步偏差", measures: "读取时钟偏差。" },
];
const round = { ...end, diagnosticCatalog: catalog };
const requested = demoSteer(round, {
  action: "request_evidence",
  evidenceClass: "logs",
  at: "2026-10-24T02:43:00Z",
});
const continued = demoContinue(requested, Date.parse("2026-10-24T02:41:00Z"));
assert.ok(continued.length >= 4);
const gate = continued.at(-1)!;
assert.equal(gate.phase, "awaiting_test_approval");
assert.equal(gate.proposal?.testId, "detector-dark-count");
assert.equal(gate.approval, null);
assert.ok(gate.evidence.some((item) => item.evidenceId.startsWith("ev-demo-follow-logs")));
assert.ok(gate.trace.some((event) => event.id.startsWith("demo-follow-logs") && event.toolName === "query_logs"));
assert.notEqual(
  gate.hypotheses.find((item) => item.id === "h-dark")?.rationale,
  round.hypotheses.find((item) => item.id === "h-dark")?.rationale,
);
assert.equal(gate.hypotheses.find((item) => item.id === "h-loss")?.status, "excluded");
assert.ok(
  gate.hypotheses.find((item) => item.id === "h-dark")?.supportingEvidenceIds.some((id) => id.startsWith("ev-demo-follow-logs")),
);

const prioritized = demoSteer(round, {
  action: "prioritize",
  hypothesisId: "h-loss",
  at: "2026-10-24T02:43:10Z",
});
const lossGate = demoContinue(prioritized, Date.parse("2026-10-24T02:41:00Z")).at(-1)!;
assert.equal(lossGate.phase, "awaiting_test_approval");
assert.equal(lossGate.proposal?.testId, "channel-loss-budget");
assert.equal(lossGate.hypotheses.find((item) => item.id === "h-loss")?.status, "priority");
assert.match(lossGate.hypotheses.find((item) => item.id === "h-loss")?.rationale ?? "", /先查信道损耗/);
assert.equal(demoContinue(lossGate, Date.parse("2026-10-24T02:41:00Z")).length, 0);

const excluded = demoSteer(round, {
  action: "exclude",
  hypothesisId: "h-dark",
  at: "2026-10-24T02:43:20Z",
});
assert.equal(excluded.hypotheses.find((item) => item.id === "h-dark")?.status, "excluded");
const excludeGate = demoContinue(excluded, Date.parse("2026-10-24T02:41:00Z")).at(-1)!;
assert.equal(excludeGate.phase, "awaiting_test_approval");
assert.equal(excludeGate.hypotheses.find((item) => item.id === "h-dark")?.status, "excluded");
assert.ok(excludeGate.trace.length > round.trace.length);
assert.ok(excludeGate.proposal);

const approved2 = demoApprove(lossGate, lossGate.proposal!.testId, "2026-10-24T02:44:00Z");
const end2 = demoEpilogue(approved2, Date.parse("2026-10-24T02:41:00Z")).at(-1)!;
assert.equal(end2.phase, "awaiting_steer");
assert.equal(end2.proposal, null);
assert.equal(end2.approval, null);
assert.equal(end2.evidence.filter((item) => item.evidenceClass === "diagnostic").length, 2);
assert.ok(
  end2.hypotheses
    .find((item) => item.id === "h-loss")
    ?.supportingEvidenceIds.some((id) => id.includes("channel-loss")),
);
assert.equal(end2.hypotheses.find((item) => item.id === "h-loss")?.status, "priority");

const again = demoSteer(end2, {
  action: "request_evidence",
  evidenceClass: "telemetry",
  at: "2026-10-24T02:45:00Z",
});
const third = demoContinue(again, Date.parse("2026-10-24T02:41:00Z")).at(-1)!;
assert.equal(third.phase, "awaiting_test_approval");
assert.equal(third.proposal?.testId, "detector-dark-count");
assert.ok(third.evidence.some((item) => item.evidenceClass === "telemetry" && item.evidenceId.startsWith("ev-demo-follow")));

const serialized = JSON.stringify({ frames, end, rejected, continued, end2, third });
assert.equal(serialized.includes("rootCause"), false);
assert.equal(serialized.includes("leakSentinel"), false);
assert.equal(serialized.includes(["hidden", "json"].join(".")), false);

console.log("demo playback smoke ok");
