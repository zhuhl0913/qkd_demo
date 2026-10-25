import { isStepCount, Output, ToolLoopAgent } from "ai";
import { investigationOutputSchema } from "./hypotheses";
import { getLanguageModel } from "./model";
import { investigationTools } from "./tools";

/** The only agent in V1. Hypotheses are Output.object, not a tool. */
export function createInvestigationAgent(instructions: string) {
  return new ToolLoopAgent({
    model: getLanguageModel(),
    instructions,
    tools: investigationTools,
    stopWhen: isStepCount(8),
    temperature: 0.2,
    output: Output.object({
      schema: investigationOutputSchema,
      name: "investigation_update",
      description:
        "Structured hypotheses plus an optional diagnostic proposal. This is not a tool.",
    }),
  });
}
