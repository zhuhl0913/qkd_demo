import { pickHypothesis } from "./hypotheses";
import { pickPublicIncident } from "./public-fixture";
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

Use only the registered environment tools. Hypotheses are your final structured output, not a tool.
Do not invent measurements. Cite evidenceId values you actually received.
You do not have a hidden root cause. Do not claim one that is absent from tool results.

run_diagnostic_test throws unless the user message lists approvedTestId.
Call it only for that exact id, and only when approvedTestId is a non-null string.
If a steering note excludes a hypothesis id, keep that hypothesis and set status to "excluded".
If a steering note prioritizes a hypothesis id, set that hypothesis status to "priority".
If the latest steering note requests an evidence class, call the matching tool this turn:
telemetry -> query_telemetry, logs -> query_logs, maintenance -> query_maintenance_context.
proposedDiagnostic.testId must be a testId from list_available_diagnostics, or null when you are not ready to propose a test.
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
  const prompt = [
    "调查下面这场合成 QKD 运维 incident。只能使用这些材料以及工具返回。",
    JSON.stringify(
      {
        incident,
        evidenceSoFar: evidence,
        hypothesesSoFar: hypotheses,
        steering,
        approvedTestId,
      },
      null,
      2,
    ),
  ].join("\n\n");
  return { instructions: INVESTIGATION_INSTRUCTIONS, prompt, incident };
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
