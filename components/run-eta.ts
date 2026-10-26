import type { DeskFocus } from "./desk-loop";
import { DEMO_STEP_MS } from "./demo-playback";
import type { Phase } from "@/lib/types";

const LIVE_BUDGET_MS: Partial<Record<Phase, number>> = {
  ingesting: 8_000,
  investigating: 45_000,
  proposing_test: 10_000,
  testing: 15_000,
  updating: 10_000,
};

export function nowMs(): number {
  return Date.now();
}

/** Coarse remaining time. Rounded so the chip does not pretend to be a clock. */
export function formatEta(remainingMs: number): string {
  if (remainingMs <= 0) return "预计已到，仍在进行";
  const seconds = remainingMs / 1000;
  const rounded = seconds < 8 ? Math.max(1, Math.ceil(seconds)) : Math.ceil(seconds / 5) * 5;
  return `约还要 ${rounded}s`;
}

export function liveRemainingMs(phase: Phase, elapsedMs: number): number | null {
  const budget = LIVE_BUDGET_MS[phase];
  if (budget == null) return null;
  return Math.max(0, budget - Math.max(0, elapsedMs));
}

export function demoRemainingMs(frameCount: number, shown: number, intoStepMs: number): number {
  if (frameCount <= 0 || shown >= frameCount) return 0;
  if (shown <= 0) return Math.max(0, (frameCount - 1) * DEMO_STEP_MS);
  const stepsAfterCurrent = frameCount - shown;
  const into = Math.min(DEMO_STEP_MS, Math.max(0, intoStepMs));
  return Math.max(0, stepsAfterCurrent * DEMO_STEP_MS - into);
}

export function postureCopy(input: { pending: boolean; paused: boolean; phase: Phase; focus: DeskFocus }): string {
  if (input.paused) return "你已接管";
  if (input.pending) return "代理进行中";
  if (input.focus === "approve" || input.phase === "awaiting_test_approval") return "等待你批准";
  if (input.focus === "steer") return "可以转向";
  if (input.phase === "concluded") return "已结束";
  if (input.phase === "error") return "停在错误";
  return "空闲";
}
