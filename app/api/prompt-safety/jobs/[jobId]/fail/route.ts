import { NextResponse } from "next/server";
import { failPromptSafetyCodexJob } from "@/lib/prompt-safety-codex-queue";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.PROMPT_SAFETY_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-prompt-safety-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized prompt safety Codex worker" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : undefined;
    const job = await failPromptSafetyCodexJob(params.jobId, message);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Prompt safety Codex job failure update failed" },
      { status: 400 },
    );
  }
}
