import { approveDiagnostic, getSession, rejectDiagnostic, toPublicSession } from "@/lib/session-store";

type DiagnosticBody = {
  decision?: "approve" | "reject";
  testId?: string;
};

export async function POST(request: Request) {
  let body: DiagnosticBody;
  try {
    body = (await request.json()) as DiagnosticBody;
  } catch {
    return Response.json({ ok: false, error: "请求体不是 JSON。" }, { status: 400 });
  }

  try {
    if (body.decision === "approve") {
      const testId = body.testId?.trim() || getSession().proposal?.testId;
      if (!testId) {
        return Response.json(
          { ok: false, error: "没有可批准的 testId。", session: toPublicSession() },
          { status: 400 },
        );
      }
      approveDiagnostic(testId);
    } else if (body.decision === "reject") {
      rejectDiagnostic();
    } else {
      return Response.json(
        { ok: false, error: "decision 必须是 approve 或 reject。", session: toPublicSession() },
        { status: 400 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "批准失败";
    return Response.json(
      { ok: false, error: message, session: toPublicSession() },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, session: toPublicSession() });
}
