import type { LanguageModel } from "ai";
import { createInvestigationAgent } from "./agent";
import { investigationOutputSchema } from "./hypotheses";
import { buildModelVisibleContext } from "./model-context";
import { getLanguageModel } from "./model";
import { isKnownDiagnostic, loadPublicIncident } from "./public-fixture";
import { applySteering } from "./steering";
import {
  appendTrace,
  getSession,
  setPhase,
  upsertEvidence,
} from "./session-store";
import type { EvidenceClass } from "./types";
import { z } from "zod";

const toolEvidenceSchema = z.object({
  evidenceId: z.string(),
  evidenceClass: z.enum(["telemetry", "logs", "maintenance", "diagnostic"]),
  title: z.string(),
  body: z.string(),
});

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "调查失败";
}

export type InvestigationRunResult = { ok: true } | { ok: false; error: string };

/**
 * One investigation turn. `model` is for tests that supply a stand-in provider.
 * The production route omits it and uses the configured provider.
 */
export async function runInvestigation(model?: LanguageModel): Promise<InvestigationRunResult> {
  const session = getSession();
  let ranDiagnostic = false;

  try {
    setPhase("ingesting");
    const visible = buildModelVisibleContext({
      incident: loadPublicIncident(session.incidentId),
      evidence: session.evidence,
      hypotheses: session.hypotheses,
      steering: session.steering,
      approvedTestId: session.approval?.testId ?? null,
    });
    // Construct the provider before leaving `ingesting`, so a missing key
    // never looks like a tool run or a diagnostic test.
    const languageModel = model ?? getLanguageModel();
    session.error = null;
    setPhase(session.approval ? "testing" : "investigating");

    const agent = createInvestigationAgent(visible.instructions, languageModel);
    const result = await agent.generate({
      prompt: visible.prompt,
      onToolExecutionEnd(event) {
        const at = new Date().toISOString();
        const toolName = event.toolCall.toolName;
        const input = event.toolCall.input;
        if (event.toolOutput.type === "tool-result") {
          appendTrace({
            id: event.toolCall.toolCallId,
            at,
            toolName,
            input,
            status: "ok",
            output: event.toolOutput.output,
          });
          const record = event.toolOutput.output as { evidence?: unknown } | null;
          const parsed = toolEvidenceSchema.safeParse(record?.evidence);
          if (parsed.success) {
            upsertEvidence({
              evidenceId: parsed.data.evidenceId,
              sourceTool: toolName,
              evidenceClass: parsed.data.evidenceClass as EvidenceClass,
              title: parsed.data.title,
              body: parsed.data.body,
            });
          }
          if (toolName === "run_diagnostic_test") ranDiagnostic = true;
          return;
        }
        appendTrace({
          id: event.toolCall.toolCallId,
          at,
          toolName,
          input,
          status: "error",
          error: errorMessage(event.toolOutput.error),
        });
      },
    });

    setPhase("updating");
    const output = investigationOutputSchema.parse(result.output);
    session.hypotheses = applySteering(output.hypotheses, session.steering, session.hypotheses);

    const proposal =
      output.proposedDiagnostic &&
      isKnownDiagnostic(session.incidentId, output.proposedDiagnostic.testId)
        ? {
            testId: output.proposedDiagnostic.testId,
            reason: output.proposedDiagnostic.reason,
          }
        : null;

    if (ranDiagnostic) {
      session.approval = null;
      session.proposal = null;
      setPhase("awaiting_steer");
    } else if (proposal) {
      session.proposal = proposal;
      setPhase("proposing_test");
      const approved = session.approval?.testId === proposal.testId;
      if (!approved) {
        setPhase("awaiting_test_approval");
      } else {
        session.error = "服务器已批准该测试，但本轮模型没有调用 run_diagnostic_test。可以再运行一次调查。";
        setPhase("awaiting_test_approval");
      }
    } else if (session.approval) {
      session.proposal = null;
      session.error = "服务器批准标记仍在，但本轮没有执行诊断，也没有新的提案。";
      setPhase("awaiting_test_approval");
    } else {
      session.proposal = null;
      setPhase("awaiting_steer");
    }

    return { ok: true };
  } catch (error) {
    session.error = errorMessage(error);
    setPhase("error");
    return { ok: false, error: session.error };
  }
}
