import { NextResponse } from "next/server";
import { failSeasonPackCodexJob, getSeasonPackCodexJob } from "@/lib/season-pack-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    let job = await getSeasonPackCodexJob(params.jobId);
    const codexState = await getCodexRuntimeState();
    if (!codexState.available && (job.status === "pending" || job.status === "running")) {
      job = await failSeasonPackCodexJob(params.jobId, codexState.message);
      return NextResponse.json({ ok: true, job, codexUnavailable: codexState });
    }
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Season pack Codex job not found" },
      { status: 404 },
    );
  }
}
