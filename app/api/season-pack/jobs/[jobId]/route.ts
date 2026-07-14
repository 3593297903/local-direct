import { NextResponse } from "next/server";
import {
  failPendingSeasonPackCodexJob,
  getSeasonPackCodexJob,
  toSeasonPackCodexJobStatusDto,
} from "@/lib/season-pack-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    let job = await getSeasonPackCodexJob(params.jobId);
    const codexState = await getCodexRuntimeState();
    if (!codexState.available && (job.status === "pending" || job.status === "running")) {
      if (job.status === "pending") {
        job = await failPendingSeasonPackCodexJob(
          params.jobId,
          codexState.message,
          codexState.code,
        );
      }
      return NextResponse.json({
        ok: true,
        job: toSeasonPackCodexJobStatusDto(job),
        codexUnavailable: codexState,
      });
    }
    return NextResponse.json({ ok: true, job: toSeasonPackCodexJobStatusDto(job) });
  } catch (error: any) {
    return fileJobRouteError(error, "Season pack Codex job not found");
  }
}
