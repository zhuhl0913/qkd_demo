import { z } from "zod";
import type { Hypothesis, HypothesisStatus } from "./types";

export const hypothesisSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["active", "excluded", "priority"]),
  rationale: z.string().min(1),
  supportingEvidenceIds: z.array(z.string()),
});

export const investigationOutputSchema = z.object({
  hypotheses: z.array(hypothesisSchema).min(1).max(6),
  proposedDiagnostic: z
    .object({
      testId: z.string().min(1),
      reason: z.string().min(1),
    })
    .nullable(),
});

export type InvestigationOutput = z.infer<typeof investigationOutputSchema>;

export function pickHypothesis(input: unknown): Hypothesis {
  const parsed = hypothesisSchema.parse(input);
  return {
    id: parsed.id,
    title: parsed.title,
    status: parsed.status as HypothesisStatus,
    rationale: parsed.rationale,
    supportingEvidenceIds: [...parsed.supportingEvidenceIds],
  };
}
