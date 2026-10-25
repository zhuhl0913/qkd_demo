import type { LanguageModelMiddleware } from "ai";
import { investigationOutputSchema, type InvestigationOutput } from "./hypotheses";
import { readModelConfig } from "./model";
import { isKnownDiagnostic, loadDiagnosticCatalog } from "./public-fixture";
import { DEFAULT_INCIDENT_ID, ENVIRONMENT_TOOL_NAMES, type EnvironmentToolName } from "./types";

/**
 * Output.object sends a JSON response format on every ToolLoopAgent step.
 * OpenAI-compatible Chat Completions providers treat that format as the
 * answer and emit the object immediately, so environment tools never run.
 *
 * Tool steps therefore use plain text plus a forced tool choice. The final
 * step is different again for SiliconFlow DeepSeek-V3.2: that model family
 * does not implement response_format, and with thinking left on the JSON is
 * written to reasoning_content while message content stays empty. Output.object
 * only parses content, so the turn ended with hypotheses=[] or a Zod error.
 * The final compatible call omits response_format, disables thinking, and
 * this middleware copies a JSON object out of reasoning text when content
 * is empty. Traces are still only real tool executions.
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

type GeneratedText = {
  content: Array<{ type: string; text?: string }>;
  structuredOutputText?: string;
};

const HYPOTHESIS_KEYS = ["hypotheses", "hypothesis", "假设"] as const;
const TITLE_KEYS = ["title", "name", "hypothesis", "summary", "标题"] as const;
const RATIONALE_KEYS = ["rationale", "reason", "explanation", "analysis", "依据", "理由", "说明"] as const;

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

function finalReminder(): string {
  const ids = loadDiagnosticCatalog(DEFAULT_INCIDENT_ID).map((item) => item.testId);
  return [
    "Environment tools for this turn are done. Do not call any tool.",
    "Reply with one JSON object and no markdown.",
    'JSON shape: {"hypotheses":[{"id":"h1","title":"中文标题","status":"active","rationale":"依据工具返回的 evidenceId","supportingEvidenceIds":["ev-id"]}],"proposedDiagnostic":null}',
    "status must be active, excluded, or priority.",
    `proposedDiagnostic is null, or {"testId": one of ${ids.join(", ")}, "reason": "why"}.`,
    "A tool name is never a testId.",
  ].join("\n");
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const text = textValue(record[key]);
    if (text) return text;
  }
  return "";
}

function normalizeStatus(value: unknown): "active" | "excluded" | "priority" {
  const text = textValue(value);
  if (text.includes("排除") || /^(excluded|exclude|rejected|dismissed)$/i.test(text)) return "excluded";
  if (text.includes("优先") || /^(priority|prioritize|prioritised|prioritized)$/i.test(text)) return "priority";
  return "active";
}

function evidenceIds(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      ids.push(item.trim());
      continue;
    }
    if (item && typeof item === "object" && "evidenceId" in item) {
      const evidenceId = textValue((item as { evidenceId?: unknown }).evidenceId);
      if (evidenceId) ids.push(evidenceId);
    }
  }
  return ids;
}

function oneHypothesis(item: unknown, index: number): InvestigationOutput["hypotheses"][number] | null {
  if (typeof item === "string" && item.trim()) {
    const text = item.trim();
    return {
      id: `h${index + 1}`,
      title: text.slice(0, 80),
      status: "active",
      rationale: text,
      supportingEvidenceIds: [],
    };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const title = firstString(record, TITLE_KEYS);
  const rationale = firstString(record, RATIONALE_KEYS) || title;
  const resolvedTitle = title || rationale.slice(0, 80);
  if (!resolvedTitle || !rationale) return null;
  const id = firstString(record, ["id", "hypothesisId"]) || `h${index + 1}`;
  return {
    id,
    title: resolvedTitle,
    status: normalizeStatus(record.status ?? record.state),
    rationale,
    supportingEvidenceIds: evidenceIds(
      record.supportingEvidenceIds ?? record.evidenceIds ?? record.evidence_ids ?? record.evidence,
    ),
  };
}

function hypothesisItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of HYPOTHESIS_KEYS) {
    const child = record[key];
    if (Array.isArray(child)) return child;
    if (child && typeof child === "object") return [child];
  }
  if (firstString(record, [...TITLE_KEYS, ...RATIONALE_KEYS])) return [record];
  return null;
}

function catalogProposal(value: unknown): InvestigationOutput["proposedDiagnostic"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw = record.proposedDiagnostic ?? record.proposed_diagnostic ?? record.proposal ?? record.diagnostic;
  if (raw == null || raw === "null") return null;
  let testId = "";
  let reason = "";
  if (typeof raw === "string") {
    testId = raw.trim();
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    const proposal = raw as Record<string, unknown>;
    testId = textValue(proposal.testId ?? proposal.test_id ?? proposal.id);
    reason = firstString(proposal, ["reason", "rationale", "why"]);
  }
  if (!testId || !isKnownDiagnostic(DEFAULT_INCIDENT_ID, testId)) return null;
  const parsed = investigationOutputSchema.shape.proposedDiagnostic.safeParse({
    testId,
    reason: reason || "该测试在公开诊断目录中。",
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Turn a loose model object into the investigation schema.
 * Returns null when the model did not actually state a hypothesis.
 * Unknown diagnostic ids, including tool names, become null.
 */
export function coerceInvestigationUpdate(value: unknown): InvestigationOutput | null {
  const items = hypothesisItems(value);
  if (!items) return null;
  const hypotheses = items
    .map((item, index) => oneHypothesis(item, index))
    .filter((item): item is InvestigationOutput["hypotheses"][number] => item != null)
    .slice(0, 6);
  if (hypotheses.length === 0) return null;
  const candidate = {
    hypotheses,
    proposedDiagnostic: catalogProposal(value),
  };
  const parsed = investigationOutputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Drop a proposed test id that is not in the public catalog. */
export function sanitizeInvestigationObject(value: unknown): unknown {
  const coerced = coerceInvestigationUpdate(value);
  if (coerced) return coerced;
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

function relaxedParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    try {
      return JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1")) as unknown;
    } catch {
      return undefined;
    }
  }
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parsedObjects(text: string): unknown[] {
  const found: unknown[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (match[1]) found.push(relaxedParse(match[1]));
  }
  found.push(relaxedParse(text));
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const end = matchingBrace(text, index);
    if (end < 0) continue;
    found.push(relaxedParse(text.slice(index, end + 1)));
    index = end;
  }
  return found.filter((item) => item !== undefined);
}

/** Last schema-valid investigation object found in model text or reasoning. */
export function repairInvestigationText(chunks: readonly string[]): string | null {
  let repaired: InvestigationOutput | null = null;
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    for (const parsed of parsedObjects(chunk)) {
      const coerced = coerceInvestigationUpdate(parsed);
      if (coerced) repaired = coerced;
    }
  }
  return repaired ? JSON.stringify(repaired) : null;
}

function answerChunks(result: GeneratedText): string[] {
  const chunks: string[] = [];
  if (result.structuredOutputText?.trim()) chunks.push(result.structuredOutputText);
  for (const part of result.content) {
    if ((part.type === "text" || part.type === "reasoning") && part.text?.trim()) chunks.push(part.text);
  }
  return chunks;
}

function repairStructuredResult<T extends GeneratedText>(result: T): T {
  const repaired = repairInvestigationText(answerChunks(result));
  if (!repaired) return result;
  const content = [{ type: "text", text: repaired }, ...result.content.filter((part) => part.type !== "text")];
  return { ...result, structuredOutputText: repaired, content: content as T["content"] };
}

/** Raw provider name plus its camelCase form. The compatible SDK spreads both into the JSON body. */
function providerOptionKeys(name: string): string[] {
  const camel = name.replace(/[_-]([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return camel === name ? [name] : [name, camel];
}

function withThinkingDisabled(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  const config = readModelConfig();
  if (config.provider !== "openai-compatible") return providerOptions;
  const key = config.providerName || "openai-compatible";
  const next: Record<string, Record<string, unknown>> = { ...providerOptions };
  for (const optionKey of providerOptionKeys(key)) {
    next[optionKey] = {
      ...(next[optionKey] ?? {}),
      enable_thinking: false,
    };
  }
  return next;
}

export const investigationLoopMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async transformParams({ params }) {
    const next = nextRequiredTool(params.prompt);
    if (!next) {
      const compatible = readModelConfig().provider === "openai-compatible";
      return {
        ...params,
        // DeepSeek V3 on SiliconFlow ignores or breaks response_format and,
        // with thinking on, leaves content empty. Ask for JSON in the prompt.
        responseFormat: compatible ? { type: "text" } : params.responseFormat,
        toolChoice: compatible ? { type: "none" } : undefined,
        tools: compatible ? params.tools : undefined,
        maxOutputTokens: Math.max(params.maxOutputTokens ?? 0, 4096),
        providerOptions: withThinkingDisabled(
          params.providerOptions as Record<string, Record<string, unknown>> | undefined,
        ) as typeof params.providerOptions,
        prompt: withReminder(asPrompt(params.prompt), finalReminder()) as typeof params.prompt,
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
    if (nextRequiredTool(params.prompt) !== null) return result;
    return repairStructuredResult(result);
  },
};
