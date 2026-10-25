import "server-only";
import { listSecretStrings, loadHiddenIncident } from "./hidden-fixture";
import { loadDiagnosticOutcome } from "./public-fixture";
import { assertModelSafe } from "./redline";
import { DEFAULT_INCIDENT_ID } from "./types";

export type SafeDiagnosticEvidence = {
  incidentId: string;
  evidence: {
    evidenceId: string;
    evidenceClass: "diagnostic";
    title: string;
    body: string;
  };
  data: {
    testId: string;
    withinLimit: boolean;
    observed: string;
  };
};

/**
 * Reads hidden.json only to check the oracle test id, then returns a
 * field-picked outcome. Hidden strings and keys are rejected by the guard.
 */
export function resolveDiagnosticEvidence(
  incidentId: string,
  testId: string,
): SafeDiagnosticEvidence {
  const hidden = loadHiddenIncident(incidentId);
  const outcome = loadDiagnosticOutcome(incidentId, testId);
  if (testId === hidden.rootCause.oracle.confirmingTestId && outcome.withinLimit) {
    throw new Error("Fixture error: confirming diagnostic is marked within limit");
  }

  const payload: SafeDiagnosticEvidence = {
    incidentId,
    evidence: {
      evidenceId: outcome.evidenceId,
      evidenceClass: "diagnostic",
      title: outcome.title,
      body: outcome.observed,
    },
    data: {
      testId: outcome.testId,
      withinLimit: outcome.withinLimit,
      observed: outcome.observed,
    },
  };
  return guardToolResult(`run_diagnostic_test:${testId}`, payload);
}

export function guardToolResult<T>(label: string, payload: T, incidentId: string = DEFAULT_INCIDENT_ID): T {
  assertModelSafe(label, payload, listSecretStrings(loadHiddenIncident(incidentId)));
  return payload;
}
