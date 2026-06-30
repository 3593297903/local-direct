import { NextResponse } from "next/server";
import { completeStoryboardCodexPanel } from "@/lib/storyboard-codex-queue";

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
    const job = await completeStoryboardCodexPanel(params.jobId, params.panelId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Storyboard Codex task completion failed" },
      { status: 400 },
    );
  }
}
