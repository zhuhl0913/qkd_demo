import type { PublicSession } from "./types";

/**
 * One investigation run is one HTTP response.
 * Each line is a public session snapshot. `progress` is mid-run.
 * `result` is the terminal line and carries ok / error.
 */
export type InvestigationEvent =
  | { type: "progress"; session: PublicSession }
  | { type: "result"; ok: true; session: PublicSession }
  | { type: "result"; ok: false; error: string; session: PublicSession };

export function encodeInvestigationEvent(event: InvestigationEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseInvestigationLine(line: string): InvestigationEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("调查进度不是 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("无法识别的调查事件");
  const record = parsed as { type?: unknown; session?: unknown; ok?: unknown; error?: unknown };
  if (!record.session || typeof record.session !== "object") throw new Error("调查事件缺少会话");
  const session = record.session as PublicSession;
  if (record.type === "progress") return { type: "progress", session };
  if (record.type === "result") {
    if (record.ok === true) return { type: "result", ok: true, session };
    const error = typeof record.error === "string" && record.error ? record.error : "调查失败";
    return { type: "result", ok: false, error, session };
  }
  throw new Error("无法识别的调查事件");
}

/** Read NDJSON investigation events, including a line split across chunks. */
export async function readInvestigationNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: InvestigationEvent) => void | Promise<void>,
): Promise<InvestigationEvent | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last: InvestigationEvent | null = null;

  const take = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = parseInvestigationLine(trimmed);
    last = event;
    await onEvent(event);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) await take(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) await take(buffer);
    return last;
  } finally {
    reader.releaseLock();
  }
}
