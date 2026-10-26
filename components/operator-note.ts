import type { PublicSession } from "@/lib/types";

export type OperatorEffect = "exclude" | "prioritize" | "request_evidence" | "note";

export type OperatorNote = {
  id: string;
  at: string;
  text: string;
  effect: OperatorEffect;
  detail: string;
  hypothesisId?: string;
  evidenceClass?: "telemetry" | "logs" | "maintenance";
};

export type InterpretedNote = {
  effect: OperatorEffect;
  text: string;
  detail: string;
  hypothesisId?: string;
  evidenceClass?: "telemetry" | "logs" | "maintenance";
};

function hypothesisIdFromText(text: string, session: PublicSession, selectedHypothesisId: string | null): string | null {
  const ranked = [...session.hypotheses].sort((left, right) => right.title.length - left.title.length);
  const found = ranked.find((item) => item.title && text.includes(item.title));
  if (found) return found.id;
  if (selectedHypothesisId && session.hypotheses.some((item) => item.id === selectedHypothesisId)) {
    return selectedHypothesisId;
  }
  return null;
}

export function interpretOperatorNote(
  raw: string,
  session: PublicSession,
  selectedHypothesisId: string | null,
): InterpretedNote | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/^(排除|exclude)\b/.test(lower) || text.startsWith("排除")) {
    const hypothesisId = hypothesisIdFromText(text, session, selectedHypothesisId);
    if (!hypothesisId) return { effect: "note", text, detail: "已记下。" };
    return { effect: "exclude", text, detail: "已排除这条假设。", hypothesisId };
  }

  if (/^(优先|prioritize)\b/.test(lower) || text.startsWith("优先")) {
    const hypothesisId = hypothesisIdFromText(text, session, selectedHypothesisId);
    if (!hypothesisId) return { effect: "note", text, detail: "已记下。" };
    return { effect: "prioritize", text, detail: "已标为优先。", hypothesisId };
  }

  const evidenceClass = /遥测|telemetry/.test(lower)
    ? "telemetry"
    : /日志|logs/.test(lower)
      ? "logs"
      : /维护|maintenance/.test(lower)
        ? "maintenance"
        : null;
  if (evidenceClass && /看|请求|要/.test(text)) {
    return { effect: "request_evidence", text, detail: "已请求这类证据。", evidenceClass };
  }

  return { effect: "note", text, detail: "已记下。" };
}
