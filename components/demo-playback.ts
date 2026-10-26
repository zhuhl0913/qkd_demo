import type { EvidenceClass, EvidenceItem, Hypothesis, Phase, PublicSession, TraceEvent } from "@/lib/types";

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

export function demoEpilogue(session: PublicSession, startedAtMs: number): PublicSession[] {
  const testId = session.approval?.testId ?? session.proposal?.testId ?? proposedTestId(session);
  const copy = diagnosticCopy(testId);
  const diagnostic = evidence({
    evidenceId: "ev-demo-diag",
    sourceTool: "run_diagnostic_test",
    evidenceClass: "diagnostic" satisfies EvidenceClass,
    title: copy.title,
    body: copy.body,
  });
  const frames: PublicSession[] = [];
  let current = pushPhase(session, "testing");
  frames.push(current);

  current = pushPhase(
    {
      ...current,
      evidence: [...current.evidence, diagnostic],
      trace: [
        ...current.trace,
        tool(
          "demo-diag",
          "run_diagnostic_test",
          { incidentId: session.incidentId, testId },
          { evidence: diagnostic },
          at(startedAtMs, 9000),
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
        if (item.id !== H_POL) return item;
        const supportingEvidenceIds = item.supportingEvidenceIds.includes(diagnostic.evidenceId)
          ? item.supportingEvidenceIds
          : [...item.supportingEvidenceIds, diagnostic.evidenceId];
        return {
          ...item,
          rationale: "诊断回放写入后，偏振控制器基矢残差仍是优先解释。损耗与暗计数没有被这次读数抬高。",
          supportingEvidenceIds,
        };
      }),
    },
    "awaiting_steer",
  );
  frames.push(current);
  return frames;
}
