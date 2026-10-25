import { z } from "zod";
import { readIncidentFile } from "./fixture-io";
import { DEFAULT_INCIDENT_ID, type DiagnosticCatalogItem, type PublicIncident } from "./types";

const publicIncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  disclaimer: z.string(),
  severity: z.string(),
  openedAt: z.string(),
  timeWindow: z.object({ from: z.string(), to: z.string() }),
  nodes: z.object({
    alice: z.string(),
    bob: z.string(),
    linkId: z.string(),
  }),
  symptoms: z.array(z.string()),
  maintenanceWindowSummary: z.string(),
});

const pointSchema = z.object({
  t: z.string(),
  qberPercent: z.number(),
  keyRateKbps: z.number(),
});

const telemetrySchema = z.object({
  evidenceId: z.string(),
  title: z.string(),
  unit: z.object({ qber: z.string(), keyRate: z.string() }),
  series: z.array(pointSchema),
});

const logEntrySchema = z.object({
  at: z.string(),
  source: z.enum(["alice", "bob", "link"]),
  message: z.string(),
});

const logsSchema = z.object({
  evidenceId: z.string(),
  title: z.string(),
  entries: z.array(logEntrySchema),
});

const ticketSchema = z.object({
  ticketId: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  nodeId: z.string(),
  summary: z.string(),
  changedComponents: z.array(z.string()),
  impactedLinkIds: z.array(z.string()),
});

const maintenanceSchema = z.object({
  evidenceId: z.string(),
  title: z.string(),
  tickets: z.array(ticketSchema),
});

const catalogItemSchema = z.object({
  testId: z.string(),
  title: z.string(),
  measures: z.string(),
});

const outcomeSchema = z.object({
  testId: z.string(),
  evidenceId: z.string(),
  title: z.string(),
  observed: z.string(),
  withinLimit: z.boolean(),
});

const diagnosticsSchema = z.object({
  catalog: z.array(catalogItemSchema),
  outcomes: z.array(outcomeSchema),
});

export type TelemetryPoint = z.infer<typeof pointSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type MaintenanceTicket = z.infer<typeof ticketSchema>;
export type DiagnosticOutcome = z.infer<typeof outcomeSchema>;

/** Drop unknown keys so a polluted object cannot ride into the prompt. */
export function pickPublicIncident(input: unknown): PublicIncident {
  const parsed = publicIncidentSchema.parse(input);
  return {
    id: parsed.id,
    title: parsed.title,
    disclaimer: parsed.disclaimer,
    severity: parsed.severity,
    openedAt: parsed.openedAt,
    timeWindow: { from: parsed.timeWindow.from, to: parsed.timeWindow.to },
    nodes: {
      alice: parsed.nodes.alice,
      bob: parsed.nodes.bob,
      linkId: parsed.nodes.linkId,
    },
    symptoms: [...parsed.symptoms],
    maintenanceWindowSummary: parsed.maintenanceWindowSummary,
  };
}

export function loadPublicIncident(incidentId: string = DEFAULT_INCIDENT_ID): PublicIncident {
  return pickPublicIncident(readIncidentFile(incidentId, "public.json"));
}

export function loadTelemetry(incidentId: string) {
  const parsed = telemetrySchema.parse(readIncidentFile(incidentId, "telemetry.json"));
  return {
    evidenceId: parsed.evidenceId,
    title: parsed.title,
    unit: { qber: parsed.unit.qber, keyRate: parsed.unit.keyRate },
    series: parsed.series.map((point) => ({
      t: point.t,
      qberPercent: point.qberPercent,
      keyRateKbps: point.keyRateKbps,
    })),
  };
}

export function loadLogs(incidentId: string) {
  const parsed = logsSchema.parse(readIncidentFile(incidentId, "logs.json"));
  return {
    evidenceId: parsed.evidenceId,
    title: parsed.title,
    entries: parsed.entries.map((entry) => ({
      at: entry.at,
      source: entry.source,
      message: entry.message,
    })),
  };
}

export function loadMaintenance(incidentId: string) {
  const parsed = maintenanceSchema.parse(readIncidentFile(incidentId, "maintenance.json"));
  return {
    evidenceId: parsed.evidenceId,
    title: parsed.title,
    tickets: parsed.tickets.map((ticket) => ({
      ticketId: ticket.ticketId,
      window: { from: ticket.window.from, to: ticket.window.to },
      nodeId: ticket.nodeId,
      summary: ticket.summary,
      changedComponents: [...ticket.changedComponents],
      impactedLinkIds: [...ticket.impactedLinkIds],
    })),
  };
}

export function loadDiagnosticCatalog(incidentId: string = DEFAULT_INCIDENT_ID): DiagnosticCatalogItem[] {
  const parsed = diagnosticsSchema.parse(readIncidentFile(incidentId, "diagnostics.json"));
  return parsed.catalog.map((item) => ({
    testId: item.testId,
    title: item.title,
    measures: item.measures,
  }));
}

export function loadDiagnosticOutcome(incidentId: string, testId: string): DiagnosticOutcome {
  const parsed = diagnosticsSchema.parse(readIncidentFile(incidentId, "diagnostics.json"));
  const outcome = parsed.outcomes.find((item) => item.testId === testId);
  if (!outcome) {
    throw new Error(`Unknown diagnostic test "${testId}"`);
  }
  return {
    testId: outcome.testId,
    evidenceId: outcome.evidenceId,
    title: outcome.title,
    observed: outcome.observed,
    withinLimit: outcome.withinLimit,
  };
}

export function isKnownDiagnostic(incidentId: string, testId: string): boolean {
  return loadDiagnosticCatalog(incidentId).some((item) => item.testId === testId);
}
