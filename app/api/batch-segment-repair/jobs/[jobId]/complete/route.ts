import { NextResponse } from "next/server";
import { z } from "zod";
import { completeBatchSegmentRepairCodexJob } from "@/lib/batch-segment-repair-codex-queue";

export const runtime = "nodejs";

const RequestSchema = z.object({ leaseId: z.string().uuid() });

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
    const { leaseId } = RequestSchema.parse(await request.json());
    const job = await completeBatchSegmentRepairCodexJob(jobId, leaseId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Batch segment repair task completion failed" },
      { status: 400 },
    );
  }
}
