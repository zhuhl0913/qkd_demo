export const PHASES = [
  "idle",
  "ingesting",
  "investigating",
  "awaiting_steer",
  "proposing_test",
  "awaiting_test_approval",
  "testing",
  "updating",
  "concluded",
  "error",
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_LABELS: Record<Phase, string> = {
  idle: "空闲",
  ingesting: "装载",
  investigating: "调查",
  awaiting_steer: "等待转向",
  proposing_test: "提出测试",
  awaiting_test_approval: "等待批准",
  testing: "测试中",
  updating: "更新假设",
  concluded: "已结束",
  error: "错误",
};

export const DEFAULT_INCIDENT_ID = "qber-rise-keyrate-drop";

export const ENVIRONMENT_TOOL_NAMES = [
  "query_telemetry",
  "query_logs",
  "query_maintenance_context",
  "list_available_diagnostics",
  "run_diagnostic_test",
] as const;

export type EnvironmentToolName = (typeof ENVIRONMENT_TOOL_NAMES)[number];

export type EvidenceClass = "telemetry" | "logs" | "maintenance" | "diagnostic";

export type HypothesisStatus = "active" | "excluded" | "priority";

export type PublicIncident = {
  id: string;
  title: string;
  disclaimer: string;
  severity: string;
  openedAt: string;
  timeWindow: { from: string; to: string };
  nodes: { alice: string; bob: string; linkId: string };
  symptoms: string[];
  maintenanceWindowSummary: string;
};

export type EvidenceItem = {
  evidenceId: string;
  sourceTool: string;
  evidenceClass: EvidenceClass;
  title: string;
  body: string;
};

export type Hypothesis = {
  id: string;
  title: string;
  status: HypothesisStatus;
  rationale: string;
  supportingEvidenceIds: string[];
};

export type TraceEvent = {
  id: string;
  at: string;
  toolName: string;
  input: unknown;
  status: "ok" | "error";
  output?: unknown;
  error?: string;
};

export type SteeringAction = "exclude" | "prioritize" | "request_evidence";

export type SteeringRecord = {
  id: string;
  action: SteeringAction;
  hypothesisId?: string;
  evidenceClass?: "telemetry" | "logs" | "maintenance";
  at: string;
};

export type DiagnosticProposal = {
  testId: string;
  reason: string;
};

export type ApprovalFlag = {
  testId: string;
  approvedAt: string;
};

export type DiagnosticCatalogItem = {
  testId: string;
  title: string;
  measures: string;
};

export type ProviderStatus = {
  provider: string;
  modelId: string;
  openaiApi: string;
  baseURL: string | null;
  configured: boolean;
};

export type PublicSession = {
  incidentId: string;
  phase: Phase;
  phaseTrail: Phase[];
  incident: PublicIncident;
  evidence: EvidenceItem[];
  hypotheses: Hypothesis[];
  trace: TraceEvent[];
  steering: SteeringRecord[];
  proposal: DiagnosticProposal | null;
  approval: ApprovalFlag | null;
  error: string | null;
  diagnosticCatalog: DiagnosticCatalogItem[];
  provider: ProviderStatus;
};
