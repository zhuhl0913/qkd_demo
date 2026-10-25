import { isKnownDiagnostic, loadDiagnosticCatalog, loadPublicIncident } from "./public-fixture";
import { readProviderStatus } from "./model";
import {
  DEFAULT_INCIDENT_ID,
  type ApprovalFlag,
  type DiagnosticProposal,
  type EvidenceItem,
  type Hypothesis,
  type Phase,
  type PublicSession,
  type SteeringRecord,
  type TraceEvent,
} from "./types";

export type Session = {
  incidentId: string;
  phase: Phase;
  phaseTrail: Phase[];
  evidence: EvidenceItem[];
  hypotheses: Hypothesis[];
  trace: TraceEvent[];
  steering: SteeringRecord[];
  proposal: DiagnosticProposal | null;
  approval: ApprovalFlag | null;
  error: string | null;
};

type Store = { session: Session };

const globalStore = globalThis as typeof globalThis & {
  __qkdIncidentSession?: Store;
};

function blankSession(): Session {
  return {
    incidentId: DEFAULT_INCIDENT_ID,
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

export function getSession(): Session {
  if (!globalStore.__qkdIncidentSession) {
    globalStore.__qkdIncidentSession = { session: blankSession() };
  }
  return globalStore.__qkdIncidentSession.session;
}

export function resetSession(): Session {
  globalStore.__qkdIncidentSession = { session: blankSession() };
  return globalStore.__qkdIncidentSession.session;
}

export function setPhase(phase: Phase): void {
  const session = getSession();
  if (session.phase === phase) return;
  session.phase = phase;
  session.phaseTrail = [...session.phaseTrail, phase];
}

export function approveDiagnostic(testId: string): ApprovalFlag {
  const session = getSession();
  if (!isKnownDiagnostic(session.incidentId, testId)) {
    throw new Error(`Unknown diagnostic test "${testId}"`);
  }
  const approval = { testId, approvedAt: new Date().toISOString() };
  session.approval = approval;
  session.error = null;
  if (
    session.phase === "idle" ||
    session.phase === "awaiting_steer" ||
    session.phase === "proposing_test" ||
    session.phase === "error"
  ) {
    setPhase("awaiting_test_approval");
  }
  return approval;
}

export function rejectDiagnostic(): void {
  const session = getSession();
  session.approval = null;
  session.proposal = null;
  session.error = null;
  setPhase("awaiting_steer");
}

export function assertDiagnosticApproved(testId: string): void {
  const approval = getSession().approval;
  if (!approval || approval.testId !== testId) {
    throw new Error(
      "HITL_GATE: run_diagnostic_test refused. Server approval flag is not set for this test.",
    );
  }
}

export function upsertEvidence(item: EvidenceItem): void {
  const session = getSession();
  const index = session.evidence.findIndex((existing) => existing.evidenceId === item.evidenceId);
  if (index === -1) session.evidence.push(item);
  else session.evidence[index] = item;
}

export function appendTrace(event: TraceEvent): void {
  getSession().trace.push(event);
}

export function toPublicSession(session: Session = getSession()): PublicSession {
  return {
    incidentId: session.incidentId,
    phase: session.phase,
    phaseTrail: [...session.phaseTrail],
    incident: loadPublicIncident(session.incidentId),
    evidence: session.evidence.map((item) => ({ ...item })),
    hypotheses: session.hypotheses.map((item) => ({
      ...item,
      supportingEvidenceIds: [...item.supportingEvidenceIds],
    })),
    trace: session.trace.map((event) => ({ ...event })),
    steering: session.steering.map((record) => ({ ...record })),
    proposal: session.proposal ? { ...session.proposal } : null,
    approval: session.approval ? { ...session.approval } : null,
    error: session.error,
    diagnosticCatalog: loadDiagnosticCatalog(session.incidentId),
    provider: readProviderStatus(),
  };
}
