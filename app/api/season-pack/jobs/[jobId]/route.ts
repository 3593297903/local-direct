import { NextResponse } from "next/server";
import { getSeasonPackCodexJob, toSeasonPackCodexJobStatusDto } from "@/lib/season-pack-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    const job = await getSeasonPackCodexJob(params.jobId);
    const status = toSeasonPackCodexJobStatusDto(job);
    const codexState = await getCodexRuntimeState();
    if (!codexState.available && (job.status === "pending" || job.status === "running")) {
      return NextResponse.json({ ok: true, job: status, codexUnavailable: codexState });
    }
    return NextResponse.json({ ok: true, job: status });
  } catch (error: any) {
    return fileJobRouteError(error, "Season pack Codex job not found");
  }
}
