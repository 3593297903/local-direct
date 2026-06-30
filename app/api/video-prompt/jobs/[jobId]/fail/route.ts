import { NextResponse } from "next/server";
import { failVideoPromptCodexJob } from "@/lib/video-prompt-codex-queue";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.VIDEO_PROMPT_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-video-prompt-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized video prompt Codex worker" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : undefined;
    const job = await failVideoPromptCodexJob(params.jobId, message);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Video prompt Codex job failure update failed" },
      { status: 400 },
    );
  }
}
