import { pickHypothesis } from "./hypotheses";
import type { Hypothesis, SteeringRecord } from "./types";

export function applySteering(
  modelHypotheses: Hypothesis[],
  steering: SteeringRecord[],
  previous: Hypothesis[],
): Hypothesis[] {
  const byId = new Map<string, Hypothesis>();
  for (const hypothesis of modelHypotheses) {
    byId.set(hypothesis.id, pickHypothesis(hypothesis));
  }
  for (const record of steering) {
    if (!record.hypothesisId) continue;
    if (record.action !== "exclude" && record.action !== "prioritize") continue;
    const existing =
      byId.get(record.hypothesisId) ??
      previous.find((item) => item.id === record.hypothesisId);
    if (!existing) continue;
    byId.set(existing.id, {
      ...pickHypothesis(existing),
      status: record.action === "exclude" ? "excluded" : "priority",
    });
  }
  return [...byId.values()];
}
