import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_INCIDENT_ID } from "./types";

const KNOWN = new Set([DEFAULT_INCIDENT_ID]);

export function assertKnownIncident(incidentId: string): void {
  if (!KNOWN.has(incidentId)) {
    throw new Error(
      `Unknown incident "${incidentId}". Known incidents: ${[...KNOWN].join(", ")}`,
    );
  }
}

export function readIncidentFile(incidentId: string, fileName: string): unknown {
  assertKnownIncident(incidentId);
  if (fileName === "hidden.json") {
    throw new Error("hidden.json cannot be read through the public fixture loader");
  }
  const filePath = path.join(process.cwd(), "fixtures", "incidents", incidentId, fileName);
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}
