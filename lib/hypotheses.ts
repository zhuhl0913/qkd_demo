import { z } from "zod";
import { loadDiagnosticCatalog } from "./public-fixture";
import type { Hypothesis, HypothesisStatus } from "./types";

export const hypothesisSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["active", "excluded", "priority"]),
  rationale: z.string().min(1),
  supportingEvidenceIds: z.array(z.string()),
});

function catalogTestIds(): [string, ...string[]] {
  const ids = loadDiagnosticCatalog().map((item) => item.testId);
  const [first, ...rest] = ids;
  if (!first) throw new Error("Diagnostic catalog is empty");
  return [first, ...rest];
}

/** Public catalog ids only. Tool names are not members of this enum. */
export const catalogTestIdSchema = z.enum(catalogTestIds());

export const investigationOutputSchema = z.object({
  hypotheses: z.array(hypothesisSchema).min(1).max(6),
  proposedDiagnostic: z
    .object({
      testId: catalogTestIdSchema.describe(
        "Copy a testId from list_available_diagnostics. Tool names are not test ids. Use null for proposedDiagnostic when no catalog test should be proposed.",
      ),
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
