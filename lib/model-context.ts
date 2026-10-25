import { pickHypothesis } from "./hypotheses";
import { loadDiagnosticCatalog, pickPublicIncident } from "./public-fixture";
import type {
  EvidenceItem,
  Hypothesis,
  PublicIncident,
  SteeringRecord,
} from "./types";

export const INVESTIGATION_INSTRUCTIONS = `You are the single engineering-ops investigator for one synthetic QKD link incident.
This is not QuantumCTek hardware, not a live link, and not a commercial key rate.
QKD fields such as QBER, key rate, and maintenance windows are scenario data only.
Do not implement or teach BB84 or any other QKD protocol.

You do not have a hidden root cause. Do not claim one that is absent from tool results.
Do not invent measurements. Cite evidenceId values you actually received from tools.

Hypotheses are the final structured object, not a tool.
Call the environment tool requested for the current step. Do not write the final JSON on a tool step.
Before that object exists, tool results are required for two of query_telemetry, query_logs, and query_maintenance_context, then list_available_diagnostics.
Call run_diagnostic_test only when approvedTestId is a non-null string, and only with that exact catalog id. It throws otherwise.

proposedDiagnostic is null when no catalog test should be proposed.
proposedDiagnostic.testId must be copied from list_available_diagnostics or from allowedDiagnosticTestIds.
These are tool names, never test ids: query_telemetry, query_logs, query_maintenance_context, list_available_diagnostics, run_diagnostic_test.

If a steering note excludes a hypothesis id, keep that hypothesis and set status to "excluded".
If a steering note prioritizes a hypothesis id, set that hypothesis status to "priority".
If the latest steering note requests an evidence class, call the matching tool:
telemetry -> query_telemetry, logs -> query_logs, maintenance -> query_maintenance_context.
Write hypothesis title and rationale in Chinese.`;

export type VisibleContextInput = {
  incident: unknown;
  evidence: EvidenceItem[];
  hypotheses: Hypothesis[];
  steering: SteeringRecord[];
  approvedTestId: string | null;
};

function pickEvidence(item: EvidenceItem): EvidenceItem {
  return {
    evidenceId: item.evidenceId,
    sourceTool: item.sourceTool,
    evidenceClass: item.evidenceClass,
    title: item.title,
    body: item.body,
  };
}

function pickSteering(record: SteeringRecord): SteeringRecord {
  return {
    id: record.id,
    action: record.action,
    hypothesisId: record.hypothesisId,
    evidenceClass: record.evidenceClass,
    at: record.at,
  };
}

/**
 * Sample model-message builder. The agent route sends this same pair
 * (instructions + user prompt). Unknown keys on the incident are dropped.
 */
export function buildModelVisibleContext(input: VisibleContextInput): {
  instructions: string;
  prompt: string;
  incident: PublicIncident;
} {
  const incident = pickPublicIncident(input.incident);
  const evidence = input.evidence.map(pickEvidence);
  const hypotheses = input.hypotheses.map((item) => pickHypothesis(item));
  const steering = input.steering.map(pickSteering);
  const approvedTestId = input.approvedTestId;
  const allowedDiagnosticTestIds = loadDiagnosticCatalog(incident.id).map((item) => item.testId);
  const instructions = [
    INVESTIGATION_INSTRUCTIONS,
    `Legal proposedDiagnostic.testId values: ${allowedDiagnosticTestIds.join(", ")}.`,
    "Any other string is invalid. Set proposedDiagnostic to null instead of inventing an id.",
  ].join("\n");
  const prompt = [
    "调查下面这场合成 QKD 运维 incident。只能使用这些材料以及工具返回。",
    "先调用环境工具。最终 JSON 里的 proposedDiagnostic.testId 只能是 allowedDiagnosticTestIds 中的一项，或把 proposedDiagnostic 设为 null。",
    JSON.stringify(
      {
        incident,
        evidenceSoFar: evidence,
        hypothesesSoFar: hypotheses,
        steering,
        approvedTestId,
        allowedDiagnosticTestIds,
      },
      null,
      2,
    ),
  ].join("\n\n");
  return { instructions, prompt, incident };
}

export function buildSampleModelMessages(input: VisibleContextInput): Array<{
  role: "system" | "user";
  content: string;
}> {
  const visible = buildModelVisibleContext(input);
  return [
    { role: "system", content: visible.instructions },
    { role: "user", content: visible.prompt },
  ];
}
