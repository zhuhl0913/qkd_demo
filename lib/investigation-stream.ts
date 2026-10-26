import "server-only";
import type { LanguageModel } from "ai";
import { encodeInvestigationEvent, type InvestigationEvent } from "./investigation-events";
import { runInvestigation } from "./run-investigation";
import { toPublicSession } from "./session-store";

export const INVESTIGATION_STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
} as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "调查失败";
}

/**
 * One in-flight investigation as NDJSON.
 *
 * ToolLoopAgent.generate stays the runtime. The loop middleware repairs the
 * final object in wrapGenerate, and that hook does not run for stream().
 * Each progress line is the public session after a phase change or a real
 * tool result. The caller still made one request.
 */
export function streamInvestigation(model?: LanguageModel, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  const local = new AbortController();
  const abort = () => local.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  return new ReadableStream({
    async start(controller) {
      const send = (event: InvestigationEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeInvestigationEvent(event)));
        } catch {
          closed = true;
        }
      };

      try {
        const result = await runInvestigation(model, {
          signal: local.signal,
          onProgress: (session) => {
            send({ type: "progress", session });
          },
        });
        const session = toPublicSession();
        if (result.ok) send({ type: "result", ok: true, session });
        else send({ type: "result", ok: false, error: result.error, session });
      } catch (error) {
        send({
          type: "result",
          ok: false,
          error: errorMessage(error),
          session: toPublicSession(),
        });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // The consumer already cancelled.
          }
        }
      }
    },
    cancel() {
      closed = true;
      local.abort();
    },
  });
}

export function investigationResponse(model?: LanguageModel, signal?: AbortSignal): Response {
  return new Response(streamInvestigation(model, signal), {
    headers: INVESTIGATION_STREAM_HEADERS,
  });
}
