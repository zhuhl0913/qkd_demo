import type { LanguageModelMiddleware } from "ai";
import { isKnownDiagnostic } from "./public-fixture";
import { DEFAULT_INCIDENT_ID, ENVIRONMENT_TOOL_NAMES, type EnvironmentToolName } from "./types";

/**
 * Output.object sends a JSON response format on every ToolLoopAgent step.
 * OpenAI-compatible Chat Completions providers treat that format as the
 * answer and emit the object immediately, so environment tools never run
 * and the model invents testIds such as "query_telemetry".
 *
 * This middleware keeps the same single agent and the same Output.object
 * final answer, but it withholds the JSON format until the required
 * environment tools have returned. Tool calls still come from the model
 * and execute through the registered tools. Nothing here writes a trace.
 */

const ENVIRONMENT_TOOLS = new Set<string>(ENVIRONMENT_TOOL_NAMES);

const EVIDENCE_TOOL = {
  telemetry: "query_telemetry",
  logs: "query_logs",
  maintenance: "query_maintenance_context",
} as const;

type EvidenceClassName = keyof typeof EVIDENCE_TOOL;

type VisiblePrompt = {
  incident?: { id?: string };
  approvedTestId?: unknown;
  steering?: Array<{ action?: unknown; evidenceClass?: unknown }>;
};

type ContentPart = {
  type?: string;
  text?: string;
  toolName?: string;
  output?: { type?: string };
};

type PromptMessage = {
  role?: string;
  content?: string | ContentPart[];
};

const FINAL_REMINDER = [
  "The environment tools for this turn are done.",
  "Return only the structured investigation object.",
  "proposedDiagnostic.testId must be copied from list_available_diagnostics, or proposedDiagnostic must be null.",
  "Never use a tool name as testId.",
].join(" ");

function asPrompt(prompt: unknown): PromptMessage[] {
  return Array.isArray(prompt) ? (prompt as PromptMessage[]) : [];
}

function userText(prompt: PromptMessage[]): string {
  const chunks: string[] = [];
  for (const message of prompt) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "text" && part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

export function readInvestigationPromptState(prompt: unknown): VisiblePrompt {
  const text = userText(asPrompt(prompt));
  const start = text.indexOf("{");
  if (start < 0) return {};
  try {
    const parsed = JSON.parse(text.slice(start)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as VisiblePrompt;
  } catch {
    return {};
  }
}

function knownIncidentId(visible: VisiblePrompt): string {
  const id = visible.incident?.id;
  return id === DEFAULT_INCIDENT_ID ? id : DEFAULT_INCIDENT_ID;
}

export function readApprovedTestId(prompt: unknown): string | null {
  const value = readInvestigationPromptState(prompt).approvedTestId;
  if (typeof value !== "string") return null;
  const testId = value.trim();
  if (!testId || !isKnownDiagnostic(DEFAULT_INCIDENT_ID, testId)) return null;
  return testId;
}

function lastEvidenceRequest(visible: VisiblePrompt): EvidenceClassName | null {
  const steering = visible.steering ?? [];
  for (let index = steering.length - 1; index >= 0; index -= 1) {
    const record = steering[index];
    if (record?.action !== "request_evidence") continue;
    if (
      record.evidenceClass === "telemetry" ||
      record.evidenceClass === "logs" ||
      record.evidenceClass === "maintenance"
    ) {
      return record.evidenceClass;
    }
  }
  return null;
}

/** Tools that must return before the structured object is requested. */
export function planRequiredTools(prompt: unknown): EnvironmentToolName[] {
  const visible = readInvestigationPromptState(prompt);
  const requested = lastEvidenceRequest(visible);
  const first: EnvironmentToolName = requested ? EVIDENCE_TOOL[requested] : "query_telemetry";
  const second: EnvironmentToolName = first === "query_logs" ? "query_maintenance_context" : "query_logs";
  const sequence: EnvironmentToolName[] = [first, second, "list_available_diagnostics"];
  if (readApprovedTestId(prompt)) sequence.push("run_diagnostic_test");
  return sequence;
}

function successfulToolNames(prompt: PromptMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of prompt) {
    if ((message.role !== "tool" && message.role !== "assistant") || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result" || !part.toolName || !ENVIRONMENT_TOOLS.has(part.toolName)) continue;
      const outputType = part.output?.type;
      if (
        outputType === "error-text" ||
        outputType === "error-json" ||
        outputType === "execution-denied" ||
        outputType == null
      ) {
        continue;
      }
      names.add(part.toolName);
    }
  }
  return names;
}

export function nextRequiredTool(prompt: unknown): EnvironmentToolName | null {
  const done = successfulToolNames(asPrompt(prompt));
  for (const name of planRequiredTools(prompt)) {
    if (!done.has(name)) return name;
  }
  return null;
}

function withReminder(prompt: PromptMessage[], reminder: string): PromptMessage[] {
  let attached = false;
  const next = prompt.map((message) => {
    if (attached || message.role !== "system" || typeof message.content !== "string") return message;
    attached = true;
    return { ...message, content: `${message.content}\n\n${reminder}` };
  });
  if (attached) return next;
  return [{ role: "system", content: reminder }, ...next];
}

function stepReminder(toolName: EnvironmentToolName, prompt: unknown): string {
  const visible = readInvestigationPromptState(prompt);
  const incidentId = knownIncidentId(visible);
  if (toolName === "run_diagnostic_test") {
    const testId = readApprovedTestId(prompt);
    return [
      "This step must call run_diagnostic_test.",
      `Use incidentId ${JSON.stringify(incidentId)} and testId ${JSON.stringify(testId)}.`,
      "Do not write the investigation JSON on this step.",
    ].join(" ");
  }
  return [
    `This step must call ${toolName}.`,
    `Use incidentId ${JSON.stringify(incidentId)}.`,
    "Do not write the investigation JSON on this step.",
    "proposedDiagnostic.testId must be a catalog id or null, never a tool name.",
  ].join(" ");
}

function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/** Drop a proposed test id that is not in the public catalog. */
export function sanitizeInvestigationObject(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  const proposal = record.proposedDiagnostic;
  if (proposal == null) return record;
  if (typeof proposal !== "object" || Array.isArray(proposal)) {
    return { ...record, proposedDiagnostic: null };
  }
  const testId = (proposal as { testId?: unknown }).testId;
  if (typeof testId !== "string" || !isKnownDiagnostic(DEFAULT_INCIDENT_ID, testId)) {
    return { ...record, proposedDiagnostic: null };
  }
  return record;
}

type GeneratedText = {
  content: Array<{ type: string; text?: string }>;
  structuredOutputText?: string;
};

function sanitizeStructuredResult<T extends GeneratedText>(result: T): T {
  const raw =
    typeof result.structuredOutputText === "string" && result.structuredOutputText.trim()
      ? result.structuredOutputText
      : result.content
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text)
          .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch {
    return result;
  }
  const sanitized = sanitizeInvestigationObject(parsed);
  const nextText = JSON.stringify(sanitized);
  const content = [
    { type: "text", text: nextText },
    ...result.content.filter((part) => part.type !== "text"),
  ];
  return { ...result, structuredOutputText: nextText, content: content as T["content"] };
}

export const investigationLoopMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async transformParams({ params }) {
    const next = nextRequiredTool(params.prompt);
    if (!next) {
      return {
        ...params,
        tools: undefined,
        toolChoice: undefined,
        prompt: withReminder(asPrompt(params.prompt), FINAL_REMINDER) as typeof params.prompt,
      };
    }
    return {
      ...params,
      responseFormat: { type: "text" },
      toolChoice: { type: "tool", toolName: next },
      prompt: withReminder(asPrompt(params.prompt), stepReminder(next, params.prompt)) as typeof params.prompt,
    };
  },
  async wrapGenerate({ doGenerate, params }) {
    const result = await doGenerate();
    if (params.responseFormat?.type !== "json") return result;
    return sanitizeStructuredResult(result);
  },
};
