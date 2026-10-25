import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertKnownIncident } from "./fixture-io";
import { DEFAULT_INCIDENT_ID } from "./types";

const hiddenSchema = z.object({
  leakSentinel: z.string().min(8),
  rootCause: z.object({
    code: z.string().min(4),
    summary: z.string().min(20),
    oracle: z.object({
      confirmingTestId: z.string().min(1),
      note: z.string().min(8),
    }),
  }),
});

export type HiddenIncident = z.infer<typeof hiddenSchema>;

/** Server diagnostic resolver only. Do not import from model-context, tools, or client code. */
export function loadHiddenIncident(incidentId: string = DEFAULT_INCIDENT_ID): HiddenIncident {
  assertKnownIncident(incidentId);
  const filePath = path.join(process.cwd(), "fixtures", "incidents", incidentId, "hidden.json");
  return hiddenSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

/** Strings that must never appear in tool results or model-visible messages. */
export function listSecretStrings(hidden: HiddenIncident): string[] {
  const sentences = hidden.rootCause.summary
    .split(/(?<=[.。])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 20);
  return [
    hidden.leakSentinel,
    hidden.rootCause.code,
    hidden.rootCause.summary,
    hidden.rootCause.oracle.note,
    ...sentences,
  ];
}
