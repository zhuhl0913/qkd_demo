import { runInvestigation } from "@/lib/run-investigation";
import { toPublicSession } from "@/lib/session-store";

export async function POST() {
  const result = await runInvestigation();
  if (!result.ok) {
    return Response.json(
      { ok: false, error: result.error, session: toPublicSession() },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, session: toPublicSession() });
}
