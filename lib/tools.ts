import { tool } from "ai";
import { z } from "zod";
import { guardToolResult, resolveDiagnosticEvidence } from "./diagnostic-resolver";
import { assertKnownIncident } from "./fixture-io";
import {
  loadDiagnosticCatalog,
  loadLogs,
  loadMaintenance,
  loadTelemetry,
} from "./public-fixture";
import { assertDiagnosticApproved } from "./session-store";
import { DEFAULT_INCIDENT_ID, type EnvironmentToolName } from "./types";

const incidentField = z
  .string()
  .describe("Incident id. Use the id from the investigation prompt.");

function requireIncident(incidentId: string | undefined): string {
  const id = incidentId?.trim() || DEFAULT_INCIDENT_ID;
  assertKnownIncident(id);
  return id;
}

function inWindow(timestamp: string, from?: string, to?: string): boolean {
  if (from && timestamp < from) return false;
  if (to && timestamp > to) return false;
  return true;
}

export const investigationTools = {
  query_telemetry: tool({
    description:
      "Read synthetic QBER and sifted key-rate samples for the incident time window. Does not reveal a root cause.",
    inputSchema: z.object({
      incidentId: incidentField,
      metric: z.enum(["qber", "key_rate", "both"]).optional(),
      from: z.string().optional().describe("Inclusive ISO-8601 lower bound."),
      to: z.string().optional().describe("Inclusive ISO-8601 upper bound."),
    }),
    execute: async ({ incidentId, metric, from, to }) => {
      const id = requireIncident(incidentId);
      const telemetry = loadTelemetry(id);
      const selected = metric ?? "both";
      const series = telemetry.series
        .filter((point) => inWindow(point.t, from, to))
        .map((point) => ({
          t: point.t,
          ...(selected !== "key_rate" ? { qberPercent: point.qberPercent } : {}),
          ...(selected !== "qber" ? { keyRateKbps: point.keyRateKbps } : {}),
        }));
      const preview = series
        .map((point) => {
          const qber = "qberPercent" in point ? ` QBER ${point.qberPercent}%` : "";
          const rate = "keyRateKbps" in point ? ` 密钥率 ${point.keyRateKbps} kbps` : "";
          return `${point.t}${qber}${rate}`;
        })
        .join("\n");
      return guardToolResult("query_telemetry", {
        incidentId: id,
        evidence: {
          evidenceId: telemetry.evidenceId,
          evidenceClass: "telemetry" as const,
          title: telemetry.title,
          body: preview || "窗口内没有采样点。",
        },
        data: {
          metric: selected,
          unit: telemetry.unit,
          from: from ?? null,
          to: to ?? null,
          series,
        },
      });
    },
  }),

  query_logs: tool({
    description:
      "Read synthetic device and link log lines for the incident. Does not reveal a root cause.",
    inputSchema: z.object({
      incidentId: incidentField,
      source: z.enum(["alice", "bob", "link", "any"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ incidentId, source, limit }) => {
      const id = requireIncident(incidentId);
      const logs = loadLogs(id);
      const selectedSource = source ?? "any";
      const cap = limit ?? 8;
      const entries = logs.entries
        .filter((entry) => selectedSource === "any" || entry.source === selectedSource)
        .slice(0, cap)
        .map((entry) => ({
          at: entry.at,
          source: entry.source,
          message: entry.message,
        }));
      return guardToolResult("query_logs", {
        incidentId: id,
        evidence: {
          evidenceId: logs.evidenceId,
          evidenceClass: "logs" as const,
          title: logs.title,
          body: entries.map((entry) => `${entry.at} [${entry.source}] ${entry.message}`).join("\n"),
        },
        data: { source: selectedSource, entries },
      });
    },
  }),

  query_maintenance_context: tool({
    description:
      "Read the synthetic maintenance window and change tickets. Does not reveal a root cause.",
    inputSchema: z.object({
      incidentId: incidentField,
      ticketId: z.string().optional(),
    }),
    execute: async ({ incidentId, ticketId }) => {
      const id = requireIncident(incidentId);
      const maintenance = loadMaintenance(id);
      const tickets = maintenance.tickets
        .filter((ticket) => !ticketId || ticket.ticketId === ticketId)
        .map((ticket) => ({
          ticketId: ticket.ticketId,
          window: { from: ticket.window.from, to: ticket.window.to },
          nodeId: ticket.nodeId,
          summary: ticket.summary,
          changedComponents: [...ticket.changedComponents],
          impactedLinkIds: [...ticket.impactedLinkIds],
        }));
      return guardToolResult("query_maintenance_context", {
        incidentId: id,
        evidence: {
          evidenceId: maintenance.evidenceId,
          evidenceClass: "maintenance" as const,
          title: maintenance.title,
          body:
            tickets
              .map(
                (ticket) =>
                  `${ticket.ticketId} ${ticket.window.from}–${ticket.window.to} ${ticket.nodeId}: ${ticket.summary}`,
              )
              .join("\n") || "没有匹配的变更单。",
        },
        data: { tickets },
      });
    },
  }),

  list_available_diagnostics: tool({
    description:
      "List diagnostic tests that can be proposed for HITL approval. Does not run them and does not include results.",
    inputSchema: z.object({
      incidentId: incidentField,
    }),
    execute: async ({ incidentId }) => {
      const id = requireIncident(incidentId);
      const tests = loadDiagnosticCatalog(id).map((item) => ({
        testId: item.testId,
        title: item.title,
        measures: item.measures,
      }));
      return guardToolResult("list_available_diagnostics", {
        incidentId: id,
        evidence: {
          evidenceId: "ev-diag-catalog",
          evidenceClass: "diagnostic" as const,
          title: "可运行诊断目录",
          body: tests.map((item) => `${item.testId}: ${item.title} — ${item.measures}`).join("\n"),
        },
        data: { tests },
      });
    },
  }),

  run_diagnostic_test: tool({
    description:
      "Run one diagnostic test. Refuses unless the server HITL approval flag is set for this exact testId. Never returns a hidden root cause.",
    inputSchema: z.object({
      incidentId: incidentField,
      testId: z.string().describe("testId from list_available_diagnostics."),
    }),
    execute: async ({ incidentId, testId }) => {
      const id = requireIncident(incidentId);
      assertDiagnosticApproved(testId);
      return resolveDiagnosticEvidence(id, testId);
    },
  }),
};

export type InvestigationTools = typeof investigationTools;

export function listRegisteredToolNames(): EnvironmentToolName[] {
  return Object.keys(investigationTools) as EnvironmentToolName[];
}
