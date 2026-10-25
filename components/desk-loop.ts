import {
  PHASE_LABELS,
  type EvidenceClass,
  type HypothesisStatus,
  type Phase,
  type PublicSession,
} from "../lib/types";

export const LOOP_STEPS = [
  { id: "query", label: "查证" },
  { id: "hypothesize", label: "假设" },
  { id: "steer", label: "转向" },
  { id: "approve", label: "批准" },
  { id: "fresh", label: "新证" },
  { id: "update", label: "更新" },
] as const;

export type LoopStepId = (typeof LOOP_STEPS)[number]["id"];
export type LoopMark = "done" | "current" | "upcoming";

export type LoopStepView = {
  id: LoopStepId;
  label: string;
  mark: LoopMark;
  done: boolean;
};

export type DeskFocus = "run" | "rerun" | "steer" | "approve" | "done" | "wait";

export type DeskMoment = {
  focus: DeskFocus;
  title: string;
  detail: string;
};

export type DeskDiff = {
  evidenceIds: string[];
  updatedEvidenceIds: string[];
  traceIds: string[];
  steerIds: string[];
  newHypothesisIds: string[];
  statusChanges: Record<string, { from: HypothesisStatus; to: HypothesisStatus }>;
  textChanges: string[];
};

export const TOOL_LABELS: Record<string, string> = {
  query_telemetry: "遥测",
  query_logs: "日志",
  query_maintenance_context: "维护",
  list_available_diagnostics: "诊断目录",
  run_diagnostic_test: "诊断测试",
};

export const EVIDENCE_CLASS_LABEL: Record<EvidenceClass, string> = {
  telemetry: "遥测",
  logs: "日志",
  maintenance: "维护",
  diagnostic: "诊断",
};

export const STATUS_LABEL: Record<HypothesisStatus, string> = {
  active: "调查中",
  excluded: "已排除",
  priority: "优先",
};

const STEP_ORDER: LoopStepId[] = ["query", "hypothesize", "steer", "approve", "fresh", "update"];

const RESTING = new Set<Phase>(["idle", "awaiting_steer", "awaiting_test_approval", "concluded", "error"]);

const INPUT_LABELS: Record<string, string> = {
  incidentId: "事件",
  testId: "测试",
  metric: "指标",
  source: "来源",
  ticketId: "工单",
  from: "从",
  to: "到",
  limit: "条数",
};

type LoopFlags = Record<LoopStepId, boolean>;

function hasFreshEvidence(session: PublicSession): boolean {
  return (
    session.evidence.some((item) => item.evidenceClass === "diagnostic") ||
    session.trace.some((event) => event.toolName === "run_diagnostic_test" && event.status === "ok")
  );
}

export function loopFlags(session: PublicSession): LoopFlags {
  const queried =
    session.evidence.some((item) => item.evidenceClass !== "diagnostic") ||
    session.trace.some((event) => event.status === "ok" && event.toolName !== "run_diagnostic_test");
  const hypothesized = session.hypotheses.length > 0;
  const steered = session.steering.length > 0;
  const fresh = hasFreshEvidence(session);
  return {
    query: queried,
    hypothesize: hypothesized,
    steer: steered,
    approve: fresh || session.approval !== null,
    fresh,
    update: fresh && hypothesized && session.phase !== "testing" && session.phase !== "updating",
  };
}

function currentStep(session: PublicSession, flags: LoopFlags, pending: boolean): LoopStepId {
  if (session.phase === "concluded" && !pending) {
    const doneIds = STEP_ORDER.filter((id) => flags[id]);
    return doneIds[doneIds.length - 1] ?? "query";
  }
  if (session.approval && !flags.fresh) return "fresh";
  if (pending) {
    // Follow the phase that the stream already published. Catalog evidence uses
    // the diagnostic class, so the fresh flag alone would skip ahead of the run.
    if (session.phase === "testing") return "fresh";
    if (session.phase === "updating") return flags.hypothesize && flags.fresh ? "update" : "hypothesize";
    if (session.phase === "proposing_test" || session.phase === "awaiting_test_approval") return "approve";
    if (session.phase === "awaiting_steer" && flags.hypothesize && !flags.fresh) {
      return flags.steer ? "query" : "steer";
    }
    if (session.phase === "investigating" || session.phase === "ingesting") return "query";
    return flags.fresh ? "update" : "query";
  }
  if (flags.update) return "update";
  if (
    !flags.fresh &&
    (session.phase === "awaiting_test_approval" ||
      session.phase === "proposing_test" ||
      session.proposal !== null)
  ) {
    return "approve";
  }
  if (session.phase === "awaiting_steer" && flags.hypothesize && !flags.fresh) {
    return flags.steer ? "query" : "steer";
  }
  return STEP_ORDER.find((id) => !flags[id]) ?? "update";
}

export function loopSteps(session: PublicSession, pending: boolean): LoopStepView[] {
  const flags = loopFlags(session);
  const current = currentStep(session, flags, pending);
  return LOOP_STEPS.map((step) => ({
    id: step.id,
    label: step.label,
    done: flags[step.id],
    mark: step.id === current ? "current" : flags[step.id] ? "done" : "upcoming",
  }));
}

export function latestLeg(trail: Phase[]): Phase[] {
  if (trail.length === 0) return [];
  let start = 0;
  for (let index = trail.length - 2; index >= 0; index -= 1) {
    const phase = trail[index];
    if (phase && RESTING.has(phase)) {
      start = index + 1;
      break;
    }
  }
  const leg = trail.slice(start);
  return leg.length > 0 ? leg : trail.slice(-1);
}

export function legLabel(trail: Phase[]): string {
  return latestLeg(trail)
    .map((phase) => PHASE_LABELS[phase])
    .join(" → ");
}

function testTitle(session: PublicSession, testId: string): string {
  return session.diagnosticCatalog.find((item) => item.testId === testId)?.title ?? testId;
}

export function deskMoment(session: PublicSession, pending: boolean): DeskMoment {
  if (pending) {
    if (session.phase === "idle") {
      return { focus: "wait", title: "调查进行中", detail: "正在接上这一轮。" };
    }
    return {
      focus: "wait",
      title: "调查进行中",
      detail: `当前阶段是${PHASE_LABELS[session.phase]}。工具返回后会出现在轨迹里。`,
    };
  }

  if (session.phase === "error") {
    return {
      focus: session.approval ? "rerun" : "run",
      title: session.approval ? "再运行调查" : "运行调查",
      detail: session.error ?? "停在「错误」。",
    };
  }

  if (session.phase === "idle") {
    return { focus: "run", title: "运行调查", detail: "查这起事件，并写出假设。" };
  }

  if (session.phase === "concluded") {
    return { focus: "done", title: "已结束", detail: "要再看一遍，点重置。" };
  }

  if (session.approval) {
    const name = testTitle(session, session.approval.testId);
    return {
      focus: "rerun",
      title: "再运行调查",
      detail: `已批准「${name}」。这一轮才会执行诊断。`,
    };
  }

  if (hasFreshEvidence(session) && session.phase === "awaiting_steer") {
    return { focus: "done", title: "假设已更新", detail: "诊断证据已写入。可以继续转向，或结束调查。" };
  }

  if (session.phase === "proposing_test" || session.phase === "awaiting_test_approval" || session.proposal) {
    const name = session.proposal ? testTitle(session, session.proposal.testId) : "";
    return {
      focus: "approve",
      title: "批准诊断",
      detail: name ? `提案是「${name}」。批准后要再运行一次。` : "选一项诊断。批准后要再运行一次。",
    };
  }

  if (session.phase === "awaiting_steer") {
    if (session.hypotheses.length === 0) {
      return { focus: "run", title: "运行调查", detail: "还没有假设。" };
    }
    if (session.steering.length === 0) {
      return { focus: "steer", title: "转向", detail: "在假设卡片上排除或标成优先，也可以请求一类证据。" };
    }
    return { focus: "run", title: "运行调查", detail: "转向会在这一轮交给模型。" };
  }

  return {
    focus: "wait",
    title: PHASE_LABELS[session.phase],
    detail: "等这一轮状态落定。",
  };
}

function blanked(session: PublicSession): boolean {
  return (
    session.phase === "idle" &&
    session.trace.length === 0 &&
    session.evidence.length === 0 &&
    session.hypotheses.length === 0 &&
    session.steering.length === 0
  );
}

export function diffSessions(before: PublicSession | null, after: PublicSession): DeskDiff | null {
  if (!before || blanked(after)) return null;
  const previousEvidence = new Map(before.evidence.map((item) => [item.evidenceId, item]));
  const evidenceIds: string[] = [];
  const updatedEvidenceIds: string[] = [];
  for (const item of after.evidence) {
    const previous = previousEvidence.get(item.evidenceId);
    if (!previous) evidenceIds.push(item.evidenceId);
    else if (previous.title !== item.title || previous.body !== item.body) updatedEvidenceIds.push(item.evidenceId);
  }
  const previousTrace = new Set(before.trace.map((event) => event.id));
  const traceIds = after.trace.filter((event) => !previousTrace.has(event.id)).map((event) => event.id);
  const previousSteer = new Set(before.steering.map((record) => record.id));
  const steerIds = after.steering.filter((record) => !previousSteer.has(record.id)).map((record) => record.id);
  const previousHypotheses = new Map(before.hypotheses.map((item) => [item.id, item]));
  const newHypothesisIds: string[] = [];
  const statusChanges: DeskDiff["statusChanges"] = {};
  const textChanges: string[] = [];
  for (const item of after.hypotheses) {
    const previous = previousHypotheses.get(item.id);
    if (!previous) {
      newHypothesisIds.push(item.id);
      continue;
    }
    if (previous.status !== item.status) {
      statusChanges[item.id] = { from: previous.status, to: item.status };
    }
    const sameText =
      previous.title === item.title &&
      previous.rationale === item.rationale &&
      previous.supportingEvidenceIds.join("\0") === item.supportingEvidenceIds.join("\0");
    if (!sameText) textChanges.push(item.id);
  }
  const diff: DeskDiff = {
    evidenceIds,
    updatedEvidenceIds,
    traceIds,
    steerIds,
    newHypothesisIds,
    statusChanges,
    textChanges,
  };
  const changed =
    evidenceIds.length +
      updatedEvidenceIds.length +
      traceIds.length +
      steerIds.length +
      newHypothesisIds.length +
      textChanges.length +
      Object.keys(statusChanges).length >
    0;
  return changed ? diff : null;
}

export function changeChips(diff: DeskDiff): string[] {
  const chips: string[] = [];
  if (diff.traceIds.length > 0) chips.push(`新工具调用 ${diff.traceIds.length}`);
  if (diff.evidenceIds.length > 0) chips.push(`新证据 ${diff.evidenceIds.length}`);
  if (diff.updatedEvidenceIds.length > 0) chips.push(`证据更新 ${diff.updatedEvidenceIds.length}`);
  if (diff.newHypothesisIds.length > 0) chips.push(`新假设 ${diff.newHypothesisIds.length}`);
  const statusCount = Object.keys(diff.statusChanges).length;
  if (statusCount > 0) chips.push(`状态变化 ${statusCount}`);
  const textOnly = diff.textChanges.filter(
    (id) => !(id in diff.statusChanges) && !diff.newHypothesisIds.includes(id),
  );
  if (textOnly.length > 0) chips.push(`依据更新 ${textOnly.length}`);
  if (diff.steerIds.length > 0) chips.push(`新转向 ${diff.steerIds.length}`);
  return chips;
}

export function shortTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const stamp = date.toISOString();
  return `${stamp.slice(5, 10)} ${stamp.slice(11, 19)}Z`;
}

export function briefInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, label] of Object.entries(INPUT_LABELS)) {
    const value = record[key];
    if (typeof value === "string" && value) parts.push(`${label} ${value}`);
    else if (typeof value === "number") parts.push(`${label} ${value}`);
  }
  return parts.join(" · ");
}

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}
