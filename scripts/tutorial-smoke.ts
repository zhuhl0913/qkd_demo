import assert from "node:assert/strict";
import { demoOpening } from "../components/demo-playback";
import {
  tutorialCanAdvance,
  tutorialCopy,
  tutorialGateHold,
  tutorialOnOpeningFrame,
  tutorialTarget,
  TUTORIAL_STEP_IDS,
  type TutorialStepId,
} from "../components/tutorial";
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

function assertPlain(text: string) {
  const stripped = text.replaceAll("不是自动修复", "").replaceAll("不会自动修复", "");
  assert.doesNotMatch(stripped, /自动修复|一键修复|已修复设备/);
  assert.doesNotMatch(text, /赋能|智能助手|欢迎来到|魔法/);
}

const frames = demoOpening(session(), Date.parse("2026-10-24T02:41:00Z"));
let step: TutorialStepId = "case";
const beats: Array<{ step: TutorialStepId; hold: boolean }> = [];
for (const frame of frames) {
  const next = tutorialOnOpeningFrame(step, frame);
  beats.push(next);
  step = next.step;
}
const holds = beats.filter((beat) => beat.hold);
assert.equal(holds.length, 1);
assert.equal(step, "work");
const moved = beats.findIndex((beat) => beat.step === "work" && !beat.hold);
const held = beats.findIndex((beat) => beat.hold);
assert.ok(moved >= 0 && moved < held);
assert.ok(tutorialWorkFrame(frames[held]!));
assert.equal(frames[held]!.proposal, null);
assert.ok(tutorialGateHold(frames.at(-1)!));
assert.equal(tutorialOnOpeningFrame("log", frames.at(-1)!).step, "gate");
assert.equal(tutorialOnOpeningFrame("log", frames.at(-1)!).hold, true);
assert.equal(tutorialOnOpeningFrame("work", frames.at(-1)!).hold, false);
assert.equal(tutorialOnOpeningFrame("result", frames.at(-1)!).step, "gate");
assert.equal(tutorialOnOpeningFrame("result", frames.at(-1)!).hold, true);
assert.equal(tutorialOnOpeningFrame("result", frames[0]!).step, "result");
assert.equal(tutorialOnOpeningFrame("result", frames[0]!).hold, false);

assert.deepEqual(
  TUTORIAL_STEP_IDS.map((id) => tutorialTarget(id)),
  ["case", "work", "log", "hitl", "work"],
);

const variants = [
  tutorialCopy("case", { pending: false, approved: false, rejected: false }),
  tutorialCopy("work", { pending: false, approved: false, rejected: false }),
  tutorialCopy("log", { pending: false, approved: false, rejected: false }),
  tutorialCopy("gate", { pending: false, approved: false, rejected: false }),
  tutorialCopy("gate", { pending: false, approved: true, rejected: false }),
  tutorialCopy("gate", { pending: false, approved: false, rejected: true }),
  tutorialCopy("result", { pending: true, approved: true, rejected: false }),
  tutorialCopy("result", { pending: false, approved: true, rejected: false }),
];
for (const copy of variants) {
  assert.ok(copy.lines.length >= 1 && copy.lines.length <= 8);
  assertPlain(copy.lines.join("\n"));
}
const waiting = tutorialCopy("gate", { pending: false, approved: false, rejected: false });
assert.match(waiting.lines.join("\n"), /批准/);
assert.match(waiting.lines.join("\n"), /不是自动修复/);
assert.equal(tutorialCanAdvance("gate", { pending: false, approved: false }), false);
assert.equal(tutorialCanAdvance("gate", { pending: false, approved: true }), true);
assert.equal(tutorialCanAdvance("gate", { pending: true, approved: true }), false);
assert.equal(tutorialCanAdvance("case", { pending: true, approved: false }), false);
assert.equal(tutorialCanAdvance("result", { pending: false, approved: true }), true);

function tutorialWorkFrame(frame: PublicSession): boolean {
  return frame.hypotheses.length > 0 && frame.proposal == null;
}

console.log("tutorial smoke ok");
