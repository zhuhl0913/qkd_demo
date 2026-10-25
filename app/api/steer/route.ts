import { applySteering } from "@/lib/steering";
import { getSession, setPhase, toPublicSession } from "@/lib/session-store";
import type { SteeringRecord } from "@/lib/types";

type SteerBody = {
  action?: SteeringRecord["action"];
  hypothesisId?: string;
  evidenceClass?: SteeringRecord["evidenceClass"];
};

export async function POST(request: Request) {
  let body: SteerBody;
  try {
    body = (await request.json()) as SteerBody;
  } catch {
    return Response.json({ ok: false, error: "请求体不是 JSON。" }, { status: 400 });
  }

  const session = getSession();
  const at = new Date().toISOString();

  if (body.action === "exclude" || body.action === "prioritize") {
    const hypothesisId = body.hypothesisId?.trim();
    if (!hypothesisId || !session.hypotheses.some((item) => item.id === hypothesisId)) {
      return Response.json(
        { ok: false, error: "没有这个假设，不能转向。", session: toPublicSession() },
        { status: 400 },
      );
    }
    session.steering.push({
      id: crypto.randomUUID(),
      action: body.action,
      hypothesisId,
      at,
    });
    session.hypotheses = applySteering(session.hypotheses, session.steering, session.hypotheses);
  } else if (body.action === "request_evidence") {
    if (
      body.evidenceClass !== "telemetry" &&
      body.evidenceClass !== "logs" &&
      body.evidenceClass !== "maintenance"
    ) {
      return Response.json(
        { ok: false, error: "证据类别必须是 telemetry、logs 或 maintenance。", session: toPublicSession() },
        { status: 400 },
      );
    }
    session.steering.push({
      id: crypto.randomUUID(),
      action: "request_evidence",
      evidenceClass: body.evidenceClass,
      at,
    });
  } else {
    return Response.json(
      { ok: false, error: "未知转向。使用 exclude、prioritize 或 request_evidence。", session: toPublicSession() },
      { status: 400 },
    );
  }

  session.error = null;
  if (session.phase === "idle" || session.phase === "error" || session.phase === "concluded") {
    setPhase("awaiting_steer");
  }

  return Response.json({ ok: true, session: toPublicSession() });
}
