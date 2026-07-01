import { NextResponse } from "next/server";
import { completePromptSafetyCodexJob } from "@/lib/prompt-safety-codex-queue";

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
    const job = await completePromptSafetyCodexJob(params.jobId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Prompt safety Codex job completion failed" },
      { status: 400 },
    );
  }
}
