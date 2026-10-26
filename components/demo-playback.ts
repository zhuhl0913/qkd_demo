import type {
  EvidenceClass,
  EvidenceItem,
  Hypothesis,
  Phase,
  PublicSession,
  SteeringRecord,
  TraceEvent,
} from "@/lib/types";

/**
 * Synthetic playback for the desk. Frames use the same PublicSession shape the
 * NDJSON stream already delivers. It does not call the agent, and it does not
 * read hidden fixtures.
 */

const STEP_MS = 1000;

export const DEMO_STEP_MS = STEP_MS;

const H_POL = "h-pol";
const H_LOSS = "h-loss";
const H_DARK = "h-dark";

type DemoDiagnostic = { title: string; body: string };

const DIAGNOSTICS: Record<string, DemoDiagnostic> = {
  "pol-controller-basis-check": {
    title: "偏振控制器基矢残差",
    body: "合成回放。Alice 端残余基矢角高于规格上限，对照变更单 CHG-4418。",
  },
  "channel-loss-budget": {
    title: "信道损耗预算",
    body: "合成回放。LN-17 分段损耗与开通基线的差落在维护窗口允许范围内。",
  },
  "detector-dark-count": {
    title: "探测器暗计数",
    body: "合成回放。Bob 端暗计数仍在基线附近，没有过载标记。",
  },
  "clock-sync-offset": {
    title: "时钟同步偏差",
    body: "合成回放。链路时钟偏差仍在门限内，同步锁定保持。",
  },
};

function at(startedAtMs: number, plusMs: number): string {
  return new Date(startedAtMs + plusMs).toISOString();
}

function pushPhase(session: PublicSession, phase: Phase): PublicSession {
  if (session.phase === phase) return session;
  return { ...session, phase, phaseTrail: [...session.phaseTrail, phase] };
}

function shell(base: PublicSession): PublicSession {
  return {
    ...base,
    phase: "idle",
    phaseTrail: ["idle"],
    evidence: [],
    hypotheses: [],
    trace: [],
    steering: [],
    proposal: null,
    approval: null,
    error: null,
  };
}

function tool(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
  stamp: string,
): TraceEvent {
  return { id, at: stamp, toolName, input, status: "ok", output };
}

function evidence(item: EvidenceItem): EvidenceItem {
  return item;
}

function proposedTestId(base: PublicSession): string {
  return (
    base.diagnosticCatalog.find((item) => item.testId === "pol-controller-basis-check")?.testId ??
    base.diagnosticCatalog[0]?.testId ??
    "pol-controller-basis-check"
  );
}

export function demoOpening(base: PublicSession, startedAtMs: number): PublicSession[] {
  const incidentId = base.incidentId;
  const testId = proposedTestId(base);
  let session = shell(base);
  const frames: PublicSession[] = [];

  const snap = (delayMs: number, next: PublicSession) => {
    session = next;
    frames.push(session);
    return delayMs;
  };

  snap(0, pushPhase(session, "ingesting"));
  snap(STEP_MS, pushPhase(session, "investigating"));

  const telemetry = evidence({
    evidenceId: "ev-demo-telemetry",
    sourceTool: "query_telemetry",
    evidenceClass: "telemetry",
    title: "LN-17 QBER 与筛选后密钥率",
    body: "合成回放。QBER 从约 1.8% 升到约 6.4%，筛选后密钥率从约 12.4 kbps 降到约 3.1 kbps。",
  });
  snap(STEP_MS * 2, {
    ...session,
    evidence: [telemetry],
    trace: [
      tool(
        "demo-telemetry",
        "query_telemetry",
        { incidentId, metric: "qber" },
        { evidence: telemetry },
        at(startedAtMs, 0),
      ),
    ],
  });

  const logs = evidence({
    evidenceId: "ev-demo-logs",
    sourceTool: "query_logs",
    evidenceClass: "logs",
    title: "LN-17 设备与链路日志",
    body: "合成回放。NODE-A-HZ-04 固件任务 CHG-4418 安装结束，后检查栏为空。随后 QBER 越过 3% 警告线。",
  });
  snap(STEP_MS * 3, {
    ...session,
    evidence: [...session.evidence, logs],
    trace: [
      ...session.trace,
      tool(
        "demo-logs",
        "query_logs",
        { incidentId, source: "alice" },
        { evidence: logs },
        at(startedAtMs, 2000),
      ),
    ],
  });

  const maintenance = evidence({
    evidenceId: "ev-demo-maint",
    sourceTool: "query_maintenance_context",
    evidenceClass: "maintenance",
    title: "变更单 CHG-4418",
    body: "合成回放。00:10–00:40 UTC 在 NODE-A-HZ-04 安装偏振控制器固件。工单已完成，没有后检查附件。",
  });
  snap(STEP_MS * 4, {
    ...session,
    evidence: [...session.evidence, maintenance],
    trace: [
      ...session.trace,
      tool(
        "demo-maint",
        "query_maintenance_context",
        { incidentId, ticketId: "CHG-4418" },
        { evidence: maintenance },
        at(startedAtMs, 4000),
      ),
    ],
  });

  const hypotheses: Hypothesis[] = [
    {
      id: H_POL,
      title: "偏振控制器固件把基矢留在规格外",
      status: "active",
      rationale: "维护窗口刚关闭，QBER 随即上升，日志指向 Alice 端偏振控制器。",
      supportingEvidenceIds: ["ev-demo-telemetry", "ev-demo-logs", "ev-demo-maint"],
    },
    {
      id: H_LOSS,
      title: "信道损耗突然变差",
      status: "active",
      rationale: "密钥率下降也可能来自分段损耗。目前只有遥测，没有损耗读数。",
      supportingEvidenceIds: ["ev-demo-telemetry"],
    },
    {
      id: H_DARK,
      title: "Bob 端探测器暗计数过载",
      status: "active",
      rationale: "暗计数过载会抬高 QBER。日志里还没有过载标记。",
      supportingEvidenceIds: ["ev-demo-logs"],
    },
  ];
  snap(STEP_MS * 5, {
    ...session,
    hypotheses,
    trace: [
      ...session.trace,
      tool(
        "demo-catalog",
        "list_available_diagnostics",
        { incidentId },
        { testIds: base.diagnosticCatalog.map((item) => item.testId) },
        at(startedAtMs, 6000),
      ),
    ],
  });

  let proposed = pushPhase(session, "proposing_test");
  proposed = pushPhase(proposed, "awaiting_test_approval");
  snap(STEP_MS * 6, {
    ...proposed,
    proposal: { testId, reason: "先核对 Alice 端偏振控制器的残余基矢角。" },
  });

  return frames;
}

export function demoApprove(session: PublicSession, testId: string, approvedAt: string): PublicSession {
  return {
    ...session,
    approval: { testId, approvedAt },
    error: null,
  };
}

export function demoReject(session: PublicSession): PublicSession {
  const next = pushPhase(
    { ...session, approval: null, proposal: null, error: null },
    "awaiting_steer",
  );
  return next;
}

export function demoSteer(
  session: PublicSession,
  action: {
    action: "exclude" | "prioritize" | "request_evidence";
    hypothesisId?: string;
    evidenceClass?: "telemetry" | "logs" | "maintenance";
    at: string;
  },
): PublicSession {
  const steering = [
    ...session.steering,
    {
      id: `demo-steer-${session.steering.length + 1}`,
      action: action.action,
      hypothesisId: action.hypothesisId,
      evidenceClass: action.evidenceClass,
      at: action.at,
    },
  ];
  const hypotheses = session.hypotheses.map((item) => {
    if (!action.hypothesisId || item.id !== action.hypothesisId) return item;
    if (action.action === "exclude") return { ...item, status: "excluded" as const };
    if (action.action === "prioritize") return { ...item, status: "priority" as const };
    return item;
  });
  let next: PublicSession = { ...session, steering, hypotheses, error: null };
  if (next.phase === "idle" || next.phase === "error" || next.phase === "concluded") {
    next = pushPhase(next, "awaiting_steer");
  }
  return next;
}

type FollowClass = "telemetry" | "logs" | "maintenance";

const FOLLOW_UP: Record<
  FollowClass,
  { tool: string; title: string; body: string; input: Record<string, unknown> }
> = {
  telemetry: {
    tool: "query_telemetry",
    title: "LN-17 后段遥测",
    body: "合成回放。02:20–02:40 UTC，QBER 停在 6.2% 到 6.5%，筛选后密钥率停在 3.4 到 3.0 kbps，没有回到约 12 kbps。",
    input: { metric: "qber", from: "2026-10-24T02:20:00Z", to: "2026-10-24T02:40:00Z" },
  },
  logs: {
    tool: "query_logs",
    title: "LN-17 后段日志",
    body: "合成回放。02:05 Bob 端暗计数快照 610 cps，无过载标记。02:16 链路时钟偏差 26 ps，同步锁定保持。",
    input: { source: "bob" },
  },
  maintenance: {
    tool: "query_maintenance_context",
    title: "变更单 CHG-4418 范围",
    body: "合成回放。CHG-4418 只改了 NODE-A-HZ-04 的偏振控制器固件，影响链路 LN-17。工单已完成，没有第二条变更单，也没有后检查附件。",
    input: { ticketId: "CHG-4418" },
  },
};

const TEST_FOR_HYPOTHESIS: Record<string, string> = {
  [H_POL]: "pol-controller-basis-check",
  [H_LOSS]: "channel-loss-budget",
  [H_DARK]: "detector-dark-count",
};

const TEST_FOR_EVIDENCE: Record<FollowClass, string> = {
  telemetry: "channel-loss-budget",
  logs: "detector-dark-count",
  maintenance: "pol-controller-basis-check",
};

const PROPOSAL_REASON: Record<string, string> = {
  "pol-controller-basis-check": "转向之后仍核对 Alice 端偏振控制器的残余基矢角。",
  "channel-loss-budget": "转向之后核对 LN-17 分段损耗，看密钥率下降是否落在损耗预算里。",
  "detector-dark-count": "转向之后读取 Bob 端暗计数，对照基线。",
  "clock-sync-offset": "转向之后读取链路时钟偏差，看同步锁定是否仍在门限内。",
};

function nextId(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  if (!taken.has(prefix)) return prefix;
  let n = 2;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

function laterThan(session: PublicSession, startedAtMs: number): number {
  return session.trace.reduce((max, event) => {
    const time = Date.parse(event.at);
    return Number.isNaN(time) ? max : Math.max(max, time);
  }, startedAtMs);
}

function readTestId(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const testId = (input as { testId?: unknown }).testId;
  return typeof testId === "string" && testId ? testId : null;
}

function executedTests(session: PublicSession): Set<string> {
  const ids = new Set<string>();
  for (const event of session.trace) {
    if (event.toolName !== "run_diagnostic_test" || event.status !== "ok") continue;
    const testId = readTestId(event.input);
    if (testId) ids.add(testId);
  }
  return ids;
}

function pickNextTest(session: PublicSession, steer: SteeringRecord): string {
  const catalog = session.diagnosticCatalog.map((item) => item.testId);
  const pool =
    catalog.length > 0
      ? catalog
      : ["pol-controller-basis-check", "channel-loss-budget", "detector-dark-count", "clock-sync-offset"];
  const preferred: string[] = [];
  if (steer.action === "prioritize" && steer.hypothesisId) {
    const mapped = TEST_FOR_HYPOTHESIS[steer.hypothesisId];
    if (mapped) preferred.push(mapped);
  }
  if (steer.action === "request_evidence" && steer.evidenceClass) {
    preferred.push(TEST_FOR_EVIDENCE[steer.evidenceClass]);
  }
  preferred.push("channel-loss-budget", "detector-dark-count", "clock-sync-offset", "pol-controller-basis-check");
  const allowed = preferred.filter((id, index) => preferred.indexOf(id) === index && pool.includes(id));
  const ran = executedTests(session);
  return allowed.find((id) => !ran.has(id)) ?? allowed[0] ?? pool[0] ?? proposedTestId(session);
}

function touchedByEvidence(hypothesisId: string, evidenceClass: FollowClass): boolean {
  if (evidenceClass === "telemetry") return hypothesisId === H_POL || hypothesisId === H_LOSS;
  if (evidenceClass === "logs") return hypothesisId === H_DARK || hypothesisId === H_POL;
  return hypothesisId === H_POL;
}

function followUpRationale(item: Hypothesis, steer: SteeringRecord): string {
  const prioritized = steer.action === "prioritize" && steer.hypothesisId === item.id;
  if (steer.action === "exclude" && item.id !== steer.hypothesisId && item.status !== "excluded") {
    if (item.id === H_POL) return "旁支先搁下。偏振控制器基矢仍留在桌上。";
    if (item.id === H_LOSS) return "旁支先搁下。信道损耗还没有诊断读数。";
    if (item.id === H_DARK) return "旁支先搁下。暗计数还没有探测器读数。";
    return "旁支先搁下。这条仍留在桌上。";
  }
  if (item.status === "excluded" && !prioritized) return item.rationale;
  if (prioritized) {
    if (item.id === H_LOSS) return "先查信道损耗。密钥率掉了，分段损耗还没有诊断读数。";
    if (item.id === H_DARK) return "先查 Bob 端暗计数。日志里还没有过载，需要探测器读数。";
    if (item.id === H_POL) return "先查偏振控制器。维护窗口刚过，QBER 就起来了。";
    return "先查这条。下一轮对着它提一项诊断。";
  }
  if (steer.action === "request_evidence" && steer.evidenceClass && touchedByEvidence(item.id, steer.evidenceClass)) {
    if (steer.evidenceClass === "telemetry" && item.id === H_LOSS) {
      return "补上的后段遥测里，密钥率仍停在 3 kbps 附近。损耗还没被诊断读数按住。";
    }
    if (steer.evidenceClass === "telemetry") {
      return "补上的后段遥测里，QBER 仍停在 6% 以上。偏振控制器基矢还压着这条解释。";
    }
    if (steer.evidenceClass === "logs" && item.id === H_DARK) {
      return "补上的日志里暗计数快照 610 cps，没有过载标记。还要用探测器诊断核对。";
    }
    if (steer.evidenceClass === "logs") {
      return "补上的日志仍是固件任务之后 QBER 越过警告线。基矢这条还在。";
    }
    return "补上的变更范围只碰到偏振控制器固件，没有第二条工单。基矢仍是先要核对的一项。";
  }
  return item.rationale;
}

function reviseHypotheses(session: PublicSession, steer: SteeringRecord, evidenceId?: string): Hypothesis[] {
  return session.hypotheses.map((item) => {
    const rationale = followUpRationale(item, steer);
    const attach =
      evidenceId &&
      item.status !== "excluded" &&
      steer.evidenceClass &&
      touchedByEvidence(item.id, steer.evidenceClass) &&
      !item.supportingEvidenceIds.includes(evidenceId);
    if (rationale === item.rationale && !attach) return item;
    return {
      ...item,
      rationale,
      supportingEvidenceIds:
        attach && evidenceId ? [...item.supportingEvidenceIds, evidenceId] : item.supportingEvidenceIds,
    };
  });
}

/**
 * On-demand next round after a steer. Starts from the steered session and ends
 * at the next approval gate. Wording stays on the public fixture facts.
 */
export function demoContinue(session: PublicSession, startedAtMs: number): PublicSession[] {
  const steer = session.steering[session.steering.length - 1];
  if (!steer) return [];
  if (session.phase !== "awaiting_steer" || session.approval) return [];

  const frames: PublicSession[] = [];
  const base = laterThan(session, startedAtMs);
  let current = pushPhase({ ...session, error: null }, "investigating");
  frames.push(current);

  let addedId: string | undefined;
  if (steer.action === "request_evidence" && steer.evidenceClass) {
    const copy = FOLLOW_UP[steer.evidenceClass];
    const evidenceIds = session.evidence.map((item) => item.evidenceId);
    const traceIds = session.trace.map((event) => event.id);
    addedId = nextId(`ev-demo-follow-${steer.evidenceClass}`, evidenceIds);
    const added = evidence({
      evidenceId: addedId,
      sourceTool: copy.tool,
      evidenceClass: steer.evidenceClass,
      title: copy.title,
      body: copy.body,
    });
    current = {
      ...current,
      evidence: [...current.evidence, added],
      trace: [
        ...current.trace,
        tool(
          nextId(`demo-follow-${steer.evidenceClass}`, traceIds),
          copy.tool,
          { incidentId: session.incidentId, ...copy.input },
          { evidence: added },
          at(base, 1000),
        ),
      ],
    };
    frames.push(current);
  } else {
    const traceIds = current.trace.map((event) => event.id);
    current = {
      ...current,
      trace: [
        ...current.trace,
        tool(
          nextId("demo-catalog-next", traceIds),
          "list_available_diagnostics",
          { incidentId: session.incidentId },
          { testIds: session.diagnosticCatalog.map((item) => item.testId) },
          at(base, 1000),
        ),
      ],
    };
    frames.push(current);
  }

  current = pushPhase(
    {
      ...current,
      hypotheses: reviseHypotheses(current, steer, addedId),
    },
    "updating",
  );
  frames.push(current);

  const testId = pickNextTest(current, steer);
  let proposed = pushPhase(current, "proposing_test");
  proposed = pushPhase(proposed, "awaiting_test_approval");
  frames.push({
    ...proposed,
    proposal: {
      testId,
      reason: PROPOSAL_REASON[testId] ?? "按这一次转向再提一项诊断。",
    },
    approval: null,
    error: null,
  });
  return frames;
}

export function carryDemoSteer(frame: PublicSession, steered: PublicSession): PublicSession {
  const statuses = new Map(steered.hypotheses.map((item) => [item.id, item.status]));
  return {
    ...frame,
    steering: steered.steering.map((record) => ({ ...record })),
    hypotheses: frame.hypotheses.map((item) => {
      const status = statuses.get(item.id);
      return status && status !== item.status ? { ...item, status } : item;
    }),
  };
}

export function demoConclude(session: PublicSession): PublicSession {
  return pushPhase({ ...session, error: null }, "concluded");
}

function diagnosticCopy(testId: string): DemoDiagnostic {
  return (
    DIAGNOSTICS[testId] ?? {
      title: testId,
      body: "合成回放。这项诊断没有另附测量原文。",
    }
  );
}

const DIAGNOSTIC_NOTE: Record<string, { hypothesisId: string; rationale: string }> = {
  "pol-controller-basis-check": {
    hypothesisId: H_POL,
    rationale: "诊断回放写入后，偏振控制器基矢残差仍是优先解释。损耗与暗计数没有被这次读数抬高。",
  },
  "channel-loss-budget": {
    hypothesisId: H_LOSS,
    rationale: "损耗预算落在维护窗口允许范围内。信道突然变差解释不了这次 QBER。",
  },
  "detector-dark-count": {
    hypothesisId: H_DARK,
    rationale: "暗计数仍在基线附近，没有过载。这条解释被这次读数压低。",
  },
  "clock-sync-offset": {
    hypothesisId: H_POL,
    rationale: "时钟偏差仍在门限内，同步锁定解释不了 QBER。基矢残差仍在桌上。",
  },
};

export function demoEpilogue(session: PublicSession, startedAtMs: number): PublicSession[] {
  const testId = session.approval?.testId ?? session.proposal?.testId ?? proposedTestId(session);
  const copy = diagnosticCopy(testId);
  const evidenceIds = session.evidence.map((item) => item.evidenceId);
  const traceIds = session.trace.map((event) => event.id);
  const firstDiagnostic = !session.evidence.some((item) => item.evidenceClass === "diagnostic");
  const evidenceId = firstDiagnostic ? "ev-demo-diag" : nextId(`ev-demo-diag-${testId}`, evidenceIds);
  const diagnostic = evidence({
    evidenceId,
    sourceTool: "run_diagnostic_test",
    evidenceClass: "diagnostic" satisfies EvidenceClass,
    title: copy.title,
    body: copy.body,
  });
  const note = DIAGNOSTIC_NOTE[testId] ?? {
    hypothesisId: H_POL,
    rationale: "这项诊断的回放已写入。它没有改设备。",
  };
  const frames: PublicSession[] = [];
  let current = pushPhase(session, "testing");
  frames.push(current);

  const stamp = laterThan(session, startedAtMs);
  current = pushPhase(
    {
      ...current,
      evidence: [...current.evidence, diagnostic],
      trace: [
        ...current.trace,
        tool(
          nextId(firstDiagnostic ? "demo-diag" : `demo-diag-${testId}`, traceIds),
          "run_diagnostic_test",
          { incidentId: session.incidentId, testId },
          { evidence: diagnostic },
          at(stamp, 1000),
        ),
      ],
    },
    "updating",
  );
  frames.push(current);

  current = pushPhase(
    {
      ...current,
      approval: null,
      proposal: null,
      hypotheses: current.hypotheses.map((item) => {
        if (item.id !== note.hypothesisId) return item;
        const supportingEvidenceIds = item.supportingEvidenceIds.includes(diagnostic.evidenceId)
          ? item.supportingEvidenceIds
          : [...item.supportingEvidenceIds, diagnostic.evidenceId];
        return {
          ...item,
          rationale: note.rationale,
          supportingEvidenceIds,
        };
      }),
    },
    "awaiting_steer",
  );
  frames.push(current);
  return frames;
}
