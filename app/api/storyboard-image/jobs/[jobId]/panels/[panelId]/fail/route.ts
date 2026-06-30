import { NextResponse } from "next/server";
import { failStoryboardCodexPanel } from "@/lib/storyboard-codex-queue";

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
    const job = await failStoryboardCodexPanel(params.jobId, params.panelId, message);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Storyboard Codex task failure update failed" },
      { status: 400 },
    );
  }
}
