import { NextResponse } from "next/server";
import { failSeasonPackCodexJob } from "@/lib/season-pack-codex-queue";
import { isCodexQuotaExhaustedMessage, markCodexQuotaExhausted } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.SEASON_PACK_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-season-pack-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized season pack Codex worker" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : undefined;
    if (isCodexQuotaExhaustedMessage(message)) {
      await markCodexQuotaExhausted("season-pack", message);
    }
    const job = await failSeasonPackCodexJob(params.jobId, message);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Season pack Codex job failure update failed" },
      { status: 400 },
    );
  }
}
