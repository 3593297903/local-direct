import { NextResponse } from "next/server";
import { z } from "zod";
import { completeBatchSegmentRepairCodexJob } from "@/lib/batch-segment-repair-codex-queue";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

const RequestSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
});

function isWorkerAuthorized(request: Request) {
  const token = process.env.BATCH_SEGMENT_REPAIR_CODEX_WORKER_TOKEN;
  return !token || request.headers.get("x-batch-segment-repair-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized batch segment repair worker" }, { status: 401 });
  }
  try {
    const { jobId } = await context.params;
    const { leaseId, fencingToken } = RequestSchema.parse(await request.json());
    const job = await completeBatchSegmentRepairCodexJob(jobId, leaseId, fencingToken);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return fileJobRouteError(error, "Batch segment repair task completion failed");
  }
}
