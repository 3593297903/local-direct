import { NextResponse } from "next/server";
import { completeSeasonPackCodexJob } from "@/lib/season-pack-codex-queue";

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
    const job = await completeSeasonPackCodexJob(params.jobId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Season pack Codex job completion failed" },
      { status: 400 },
    );
  }
}
