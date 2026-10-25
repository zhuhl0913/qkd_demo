import { isStepCount, Output, ToolLoopAgent, wrapLanguageModel, type LanguageModel } from "ai";
import { investigationOutputSchema } from "./hypotheses";
import { investigationLoopMiddleware } from "./investigation-loop";
import { getLanguageModel } from "./model";
import { investigationTools } from "./tools";

function asProviderModel(model: LanguageModel) {
  if (typeof model === "string") {
    throw new Error(`模型 id "${model}" 不能直接交给调查循环。`);
  }
  return model;
}

/**
 * The only agent in V1. Hypotheses stay Output.object, not a tool.
 *
 * The loop middleware withholds the JSON response format until environment
 * tools have returned. Without that split, structured output and tools share
 * one request and compatible providers skip the tools.
 */
export function createInvestigationAgent(
  instructions: string,
  model: LanguageModel = getLanguageModel(),
) {
  return new ToolLoopAgent({
    model: wrapLanguageModel({
      model: asProviderModel(model),
      middleware: investigationLoopMiddleware,
    }),
    instructions,
    tools: investigationTools,
    stopWhen: isStepCount(10),
    temperature: 0.2,
    output: Output.object({
      schema: investigationOutputSchema,
      name: "investigation_update",
      description:
        "Structured hypotheses plus an optional diagnostic proposal. proposedDiagnostic.testId is a catalog id or the proposal is null. This is not a tool.",
    }),
  });
}
