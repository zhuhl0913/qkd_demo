import assert from "node:assert/strict";
import { demoApprove, demoEpilogue, demoOpening, demoReject, demoSteer } from "../components/demo-playback";
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

const serialized = JSON.stringify({ frames, end, rejected });
assert.equal(serialized.includes("rootCause"), false);
assert.equal(serialized.includes("leakSentinel"), false);
assert.equal(serialized.includes(["hidden", "json"].join(".")), false);

console.log("demo playback smoke ok");
