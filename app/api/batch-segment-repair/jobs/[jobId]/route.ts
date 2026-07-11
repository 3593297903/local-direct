import { NextResponse } from "next/server";
import { getBatchSegmentRepairCodexJob } from "@/lib/batch-segment-repair-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const job = await getBatchSegmentRepairCodexJob(jobId);
    const codexState = await getCodexRuntimeState();
    return NextResponse.json({ ok: true, job, codexState });
  } catch (error: any) {
    return fileJobRouteError(error, "Batch segment repair job read failed");
  }
}
