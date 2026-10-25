import { connection } from "next/server";
import { getSession, resetSession, setPhase, toPublicSession } from "@/lib/session-store";

export async function GET() {
  await connection();
  return Response.json(
    { ok: true, session: toPublicSession() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let body: { action?: string } = {};
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    body = {};
  }

  if (body.action === "reset") {
    resetSession();
    return Response.json({ ok: true, session: toPublicSession() });
  }

  if (body.action === "conclude") {
    const session = getSession();
    if (session.hypotheses.length === 0) {
      return Response.json(
        { ok: false, error: "还没有假设，不能结束。", session: toPublicSession() },
        { status: 400 },
      );
    }
    session.error = null;
    setPhase("concluded");
    return Response.json({ ok: true, session: toPublicSession() });
  }

  return Response.json(
    { ok: false, error: "未知操作。使用 reset 或 conclude。", session: toPublicSession() },
    { status: 400 },
  );
}
