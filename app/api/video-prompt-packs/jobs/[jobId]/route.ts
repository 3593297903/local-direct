import { NextResponse } from "next/server";
import { getVideoPromptPackCodexJob } from "@/lib/video-prompt-pack-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    const job = await getVideoPromptPackCodexJob(params.jobId);
    const codexState = await getCodexRuntimeState();
    if (!codexState.available && (job.status === "pending" || job.status === "running")) {
      return NextResponse.json({ ok: true, job, codexUnavailable: codexState });
    }
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return fileJobRouteError(error, "Video prompt render pack Codex job not found");
  }
}
