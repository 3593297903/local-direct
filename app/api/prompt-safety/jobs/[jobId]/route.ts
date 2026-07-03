import { NextResponse } from "next/server";
import { failPromptSafetyCodexJob, getPromptSafetyCodexJob } from "@/lib/prompt-safety-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    let job = await getPromptSafetyCodexJob(params.jobId);
    const codexState = await getCodexRuntimeState();
    if (!codexState.available && (job.status === "pending" || job.status === "running")) {
      job = await failPromptSafetyCodexJob(params.jobId, codexState.message);
      return NextResponse.json({ ok: true, job, codexUnavailable: codexState });
    }
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Prompt safety Codex job not found" },
      { status: 404 },
    );
  }
}
