import { NextResponse } from "next/server";
import { failVideoPromptPackCodexJob } from "@/lib/video-prompt-pack-codex-queue";
import { isCodexQuotaExhaustedMessage, markCodexQuotaExhausted } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.VIDEO_PROMPT_PACK_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-video-prompt-pack-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized video prompt render pack Codex worker" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : undefined;
    if (isCodexQuotaExhaustedMessage(message)) {
      await markCodexQuotaExhausted("video-prompt-pack", message);
    }
    const job = await failVideoPromptPackCodexJob(params.jobId, message);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Video prompt render pack Codex job failure update failed" },
      { status: 400 },
    );
  }
}
