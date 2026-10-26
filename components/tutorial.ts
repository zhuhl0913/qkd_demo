import type { PublicSession } from "@/lib/types";

/**
 * Tutorial is demo playback plus a short coach. It does not call the agent.
 * 「演示回放」 stays silent: same frames, no coach copy.
 * Approving a test runs the diagnostic tool. It does not repair the link.
 */

export const TUTORIAL_STEP_IDS = ["case", "work", "log", "gate", "result"] as const;

export type TutorialStepId = (typeof TUTORIAL_STEP_IDS)[number];

export type TutorialTarget = "case" | "work" | "log" | "hitl";

export type TutorialCopy = {
  title: string;
  lines: readonly string[];
  nextLabel: string;
  nextTitle?: string;
};

const TITLES: Record<TutorialStepId, string> = {
  case: "工单",
  work: "证据和假设",
  log: "运行日志",
  gate: "批准诊断",
  result: "诊断结果",
};

export function tutorialTarget(step: TutorialStepId): TutorialTarget {
  if (step === "case") return "case";
  if (step === "log") return "log";
  if (step === "gate") return "hitl";
  return "work";
}

export function tutorialIndex(step: TutorialStepId): number {
  return TUTORIAL_STEP_IDS.indexOf(step) + 1;
}

/** Pause opening playback on the hypotheses frame, before the approval frame. */
export function tutorialWorkHold(frame: PublicSession): boolean {
  return frame.hypotheses.length > 0 && frame.proposal == null;
}

/** Pause opening playback once the diagnostic proposal is on screen. */
export function tutorialGateHold(frame: PublicSession): boolean {
  return frame.phase === "awaiting_test_approval" && frame.proposal != null;
}

/**
 * Drive the coach from a playback frame. Hold means stop the clock so the
 * operator can read, or click 批准 themselves on the gate frame.
 */
export function tutorialOnOpeningFrame(
  step: TutorialStepId,
  frame: PublicSession,
): { step: TutorialStepId; hold: boolean } {
  if (step === "log" || step === "gate") {
    if (tutorialGateHold(frame)) return { step: "gate", hold: true };
    return { step, hold: false };
  }
  if (step === "case" || step === "work") {
    if (tutorialWorkHold(frame)) return { step: "work", hold: true };
    if (step === "case" && frame.evidence.length > 0) return { step: "work", hold: false };
    return { step, hold: false };
  }
  return { step, hold: false };
}

export function tutorialCopy(
  step: TutorialStepId,
  input: { pending: boolean; approved: boolean; rejected: boolean },
): TutorialCopy {
  const title = TITLES[step];
  if (step === "case") {
    return {
      title,
      nextLabel: "下一步",
      lines: [
        "左栏是这张工单。",
        "链路、症状、观察窗、开单时间和维护窗口都在这里。",
        "调查还没开始。下一步用合成回放把证据打出来。",
      ],
    };
  }
  if (step === "work") {
    return {
      title,
      nextLabel: "下一步",
      lines: [
        "中栏上面是假设，下面是证据。",
        "回放先写入遥测、日志和维护，再列出解释。",
        "点开一条假设可看依据。排除和优先只改调查方向，不改设备。",
      ],
    };
  }
  if (step === "log") {
    return {
      title,
      nextLabel: "下一步",
      lines: [
        "右栏是运行日志。每一行是一次工具调用。",
        "底下可以记备注。「排除」「优先」「看日志」会走转向，其他句子只留在日志里。",
        "回放可以暂停，停在当前帧。「交接稿」只导出这一屏，不触发修复。",
      ],
    };
  }
  if (step === "gate") {
    if (input.rejected) {
      return {
        title,
        nextLabel: "下一步",
        nextTitle: "已拒绝，这项测试不会跑",
        lines: [
          "已拒绝。这项测试不跑。",
          "拒绝也不会改设备。",
          "要再看诊断回放，退出后点「重置」，重新进教程并批准。",
        ],
      };
    }
    if (input.approved) {
      return {
        title,
        nextLabel: "下一步",
        lines: [
          "已记下批准。",
          "下一步把这项诊断的回放跑完，新证据进中栏。",
          "批准只留下证据，不会改设备。也可以自己点「再运行调查」。",
        ],
      };
    }
    return {
      title,
      nextLabel: "下一步",
      nextTitle: "先点底栏的批准",
      lines: [
        "底栏是诊断门闩。先在下拉里确认测试。",
        "「批准」会跑这项诊断工具，结果写成一条新证据。",
        "批准不是自动修复，也不改链路或设备。",
        "「拒绝」退回，这项测试不跑。",
        "请自己点一次「批准」。",
      ],
    };
  }
  if (input.pending) {
    return {
      title,
      nextLabel: "完成",
      lines: ["正在回放诊断结果。", "新证据进中栏后，对应假设的依据会改。", "这不是修复。"],
    };
  }
  return {
    title,
    nextLabel: "完成",
      lines: [
      "诊断证据已写入，假设依据已更新。",
      "这仍是调查记录，不是修复。",
      "点「完成」后可导出交接稿。要走真实调查，先「重置」，再点「运行调查」。",
    ],
  };
}

export function tutorialCanAdvance(
  step: TutorialStepId,
  input: { pending: boolean; approved: boolean },
): boolean {
  if (input.pending) return false;
  if (step === "gate") return input.approved;
  return true;
}
