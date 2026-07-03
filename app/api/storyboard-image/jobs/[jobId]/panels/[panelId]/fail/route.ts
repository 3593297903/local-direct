import { NextResponse } from "next/server";
import { failStoryboardCodexJob, failStoryboardCodexPanel } from "@/lib/storyboard-codex-queue";
import { isCodexQuotaExhaustedMessage, markCodexQuotaExhausted } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.STORYBOARD_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-storyboard-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string; panelId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized storyboard Codex worker" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : undefined;
    if (isCodexQuotaExhaustedMessage(message)) {
      await markCodexQuotaExhausted("storyboard-image", message);
      const job = await failStoryboardCodexJob(params.jobId, message);
      return NextResponse.json({ ok: true, job });
    }
    const job = await failStoryboardCodexPanel(params.jobId, params.panelId, message);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Storyboard Codex task failure update failed" },
      { status: 400 },
    );
  }
}
