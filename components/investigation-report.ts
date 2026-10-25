import {
  EVIDENCE_CLASS_LABEL,
  STATUS_LABEL,
  briefInput,
  hasFreshEvidence,
  shortTime,
  toolLabel,
} from "./desk-loop";
import {
  PHASE_LABELS,
  type Hypothesis,
  type HypothesisStatus,
  type PublicSession,
  type SteeringRecord,
  type TraceEvent,
} from "../lib/types";

const STATUS_RANK: Record<HypothesisStatus, number> = {
  priority: 0,
  active: 1,
  excluded: 2,
};

export function canExportReport(session: Pick<PublicSession, "hypotheses" | "evidence">): boolean {
  return session.hypotheses.length > 0 || session.evidence.length > 0;
}

export function investigationReportFileName(session: Pick<PublicSession, "incidentId">): string {
  const safe = session.incidentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `investigation-report-${safe || "incident"}.md`;
}

export function buildInvestigationReport(
  session: PublicSession,
  options: { generatedAt?: string } = {},
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const incident = session.incident;
  const blocks = [
    ["# 调查报告", "", `**${oneLine(incident.title) || incident.id}**`, "", quote(incident.disclaimer)].join("\n"),
    [
      "## 事件摘要",
      "",
      `- 事件：${incident.id}`,
      `- 严重级别：${incident.severity}`,
      `- 链路：${incident.nodes.linkId}（${incident.nodes.alice} → ${incident.nodes.bob}）`,
      `- 打开时间：${shortTime(incident.openedAt)}`,
      `- 时间窗：${shortTime(incident.timeWindow.from)} – ${shortTime(incident.timeWindow.to)}`,
      `- 导出时间：${shortTime(generatedAt)}`,
      "",
      "症状：",
      ...(incident.symptoms.length > 0
        ? incident.symptoms.map((item) => `- ${oneLine(item)}`)
        : ["- 没有记录症状。"]),
      "",
      `维护背景：${oneLine(incident.maintenanceWindowSummary) || "没有维护摘要。"}`,
    ].join("\n"),
    phaseBlock(session),
    hypothesisBlock(session),
    steeringBlock(session),
    diagnosticBlock(session),
    evidenceBlock(session),
    traceBlock(session),
    [
      "## 说明",
      "",
      "本文件是调查台对当前公开会话的本地导出，用来交接阅读。它不是外部工单系统里的单据，也不会触发修复。导出不会再跑一轮调查。",
    ].join("\n"),
  ];
  return `${blocks.join("\n\n")}\n`;
}

export function downloadInvestigationReport(
  session: PublicSession,
  generatedAt = new Date().toISOString(),
): string {
  const fileName = investigationReportFileName(session);
  const markdown = buildInvestigationReport(session, { generatedAt });
  if (typeof document === "undefined") return fileName;
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
}

function phaseBlock(session: PublicSession): string {
  const lines = [
    "## 阶段",
    "",
    `- 当前阶段：${PHASE_LABELS[session.phase]}`,
    `- 经过：${session.phaseTrail.map((phase) => PHASE_LABELS[phase]).join(" → ")}`,
    "",
    phaseNote(session),
  ];
  if (session.error?.trim() && session.phase !== "error") {
    lines.push("", `记录的错误：${oneLine(session.error)}`);
  }
  return lines.join("\n");
}

function phaseNote(session: PublicSession): string {
  if (session.phase === "concluded") {
    return "本次调查已结束。下面是结束时的假设、证据和诊断记录，供交接阅读。调查台不会自动修复链路。";
  }
  if (session.phase === "error") {
    const reason = session.error?.trim();
    return reason ? `调查停在错误。${oneLine(reason)}` : "调查停在错误。";
  }
  if (session.phase === "awaiting_steer" && hasFreshEvidence(session)) {
    return "假设已更新。诊断证据已经写入这次会话。可以按本报告交接，也可以继续转向。调查台不会自动修复链路。";
  }
  if (session.phase === "awaiting_test_approval" || session.phase === "proposing_test") {
    return "已有诊断提案，等待人工批准。批准之前不会执行测试。";
  }
  if (session.approval && !hasFreshEvidence(session)) {
    const name = catalogTitle(session, session.approval.testId);
    return `已批准「${name}」。下一次调查运行才会执行这项诊断。`;
  }
  if (session.phase === "awaiting_steer") {
    return "调查停在等待转向。假设已经写出，还没有新的诊断证据。";
  }
  if (session.phase === "idle") {
    return "会话仍是空闲。本报告只收录当前已经装入的公开内容。";
  }
  return `调查仍在进行，当前阶段是${PHASE_LABELS[session.phase]}。本报告是这一刻的快照。`;
}

function hypothesisBlock(session: PublicSession): string {
  if (session.hypotheses.length === 0) {
    return ["## 假设", "", "还没有假设。"].join("\n");
  }
  const cards = orderedHypotheses(session.hypotheses).map((item) => {
    const evidence =
      item.supportingEvidenceIds.length > 0
        ? item.supportingEvidenceIds.map((id) => evidenceTitle(session, id)).join("、")
        : "无";
    return [
      `### ${oneLine(item.title) || item.id}`,
      "",
      `- 状态：${STATUS_LABEL[item.status]}`,
      `- 支撑证据：${evidence}`,
      "",
      prose(item.rationale),
    ].join("\n");
  });
  return ["## 假设", "", cards.join("\n\n")].join("\n");
}

function steeringBlock(session: PublicSession): string {
  if (session.steering.length === 0) {
    return ["## 转向", "", "还没有转向。"].join("\n");
  }
  const lines = session.steering.map((record) => `- ${steeringLine(record, session)}`);
  return ["## 转向", "", ...lines].join("\n");
}

function steeringLine(record: SteeringRecord, session: PublicSession): string {
  const when = shortTime(record.at);
  if (record.action === "request_evidence") {
    const label = record.evidenceClass ? EVIDENCE_CLASS_LABEL[record.evidenceClass] : "未指定";
    return `${when} · 请求${label}证据`;
  }
  const name = record.hypothesisId
    ? hypothesisTitle(session, record.hypothesisId)
    : "未指明的假设";
  const verb = record.action === "exclude" ? "排除" : "优先调查";
  return `${when} · ${verb}「${name}」`;
}

function diagnosticBlock(session: PublicSession): string {
  const executed = executedDiagnostics(session);
  const lines = ["## 诊断", ""];
  if (session.proposal) {
    const title = catalogTitle(session, session.proposal.testId);
    lines.push(`- 提案：${title}（${session.proposal.testId}）`);
    lines.push(`- 理由：${oneLine(session.proposal.reason) || "没有写理由。"}`);
  } else if (executed.length > 0) {
    lines.push("- 提案：诊断已经执行，当前没有新的待批提案。");
  } else {
    lines.push("- 提案：当前没有待批诊断。");
  }
  for (const testId of executed) {
    lines.push(`- 已执行：${catalogTitle(session, testId)}（${testId}）。结果写在证据要点里。`);
  }
  if (session.approval) {
    const title = catalogTitle(session, session.approval.testId);
    lines.push(`- 批准：${shortTime(session.approval.approvedAt)} 批准「${title}」。`);
  } else if (executed.length === 0) {
    lines.push("- 批准：尚未批准。未批准的测试不会执行。");
  }
  return lines.join("\n");
}

function executedDiagnostics(session: PublicSession): string[] {
  const ids: string[] = [];
  for (const event of session.trace) {
    if (event.toolName !== "run_diagnostic_test" || event.status !== "ok") continue;
    const input = event.input;
    const testId =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as { testId?: unknown }).testId
        : undefined;
    if (typeof testId === "string" && testId && !ids.includes(testId)) ids.push(testId);
  }
  return ids;
}

function evidenceBlock(session: PublicSession): string {
  if (session.evidence.length === 0) {
    return ["## 证据要点", "", "还没有证据。"].join("\n");
  }
  const cards = session.evidence.map((item) => {
    const heading = `### ${EVIDENCE_CLASS_LABEL[item.evidenceClass]} · ${oneLine(item.title) || item.evidenceId}`;
    return [heading, "", `编号：${item.evidenceId}`, "", fenced(item.body)].join("\n");
  });
  return ["## 证据要点", "", cards.join("\n\n")].join("\n");
}

function traceBlock(session: PublicSession): string {
  if (session.trace.length === 0) {
    return ["## 工具轨迹", "", "这一会话还没有工具调用。"].join("\n");
  }
  const ok = session.trace.filter((event) => event.status === "ok").length;
  const failed = session.trace.length - ok;
  const lines = session.trace.map((event) => traceLine(event));
  return ["## 工具轨迹", "", `共 ${session.trace.length} 次，成功 ${ok}，失败 ${failed}。`, "", ...lines].join("\n");
}

function traceLine(event: TraceEvent): string {
  const status = event.status === "ok" ? "成功" : "失败";
  const summary = briefInput(event.input);
  const head = `- ${shortTime(event.at)} · ${toolLabel(event.toolName)} · ${status}`;
  const withInput = summary ? `${head} · ${summary}` : head;
  if (event.status === "error" && event.error?.trim()) {
    return `${withInput}\n  - ${oneLine(event.error)}`;
  }
  return withInput;
}

function orderedHypotheses(items: Hypothesis[]): Hypothesis[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => STATUS_RANK[left.item.status] - STATUS_RANK[right.item.status] || left.index - right.index)
    .map(({ item }) => item);
}

function catalogTitle(session: PublicSession, testId: string): string {
  return session.diagnosticCatalog.find((item) => item.testId === testId)?.title ?? testId;
}

function hypothesisTitle(session: PublicSession, hypothesisId: string): string {
  return session.hypotheses.find((item) => item.id === hypothesisId)?.title ?? hypothesisId;
}

function evidenceTitle(session: PublicSession, evidenceId: string): string {
  const found = session.evidence.find((item) => item.evidenceId === evidenceId);
  return found ? found.title : `${evidenceId}（未出现在证据板）`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quote(text: string): string {
  const line = oneLine(text);
  return line ? `> ${line}` : "> 合成演练数据。";
}

function prose(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "（没有写理由。）";
  return trimmed
    .split("\n")
    .map((line) => line.replace(/^(\s*)(#+\s)/, "$1\\$2"))
    .join("\n");
}

function fenced(text: string): string {
  const body = text.replace(/\s+$/g, "");
  if (!body) return "（无正文）";
  const run = body.match(/`{3,}/g)?.reduce((max, item) => Math.max(max, item.length), 0) ?? 0;
  const tick = "`".repeat(Math.max(3, run + 1));
  return `${tick}text\n${body}\n${tick}`;
}
