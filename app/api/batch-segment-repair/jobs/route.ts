import { NextResponse } from "next/server";
import { z } from "zod";
import { createBatchSegmentRepairCodexJob } from "@/lib/batch-segment-repair-codex-queue";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

const RequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  batchId: z.string().min(1).max(200),
  segmentIndex: z.number().int().min(1).max(30),
  slotId: z.string().max(200).optional(),
  contractHash: z.string().min(1).max(200),
  resultHash: z.string().min(1).max(200),
  sourceTextForModel: z.string().min(1).max(20_000),
  allowedPaths: z.array(z.string().min(1).max(200)).min(1).max(16),
  currentValues: z.record(z.string(), z.string()),
  findings: z.array(z.object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(1_000),
    path: z.string().max(200).optional(),
    slotId: z.string().max(200).optional(),
  })).min(1).max(16),
  forbiddenFutureEvents: z.array(z.string().max(1_000)).max(20).optional(),
});

export async function POST(request: Request) {
  try {
    await assertCodexRuntimeAvailable();
    const input = RequestSchema.parse(await request.json());
    const job = await createBatchSegmentRepairCodexJob(input);
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    const isQuotaError = error?.code === CODEX_QUOTA_EXHAUSTED_CODE
      || String(error?.message || "").includes(CODEX_QUOTA_EXHAUSTED_CODE);
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Batch segment repair job creation failed",
        code: isQuotaError ? CODEX_QUOTA_EXHAUSTED_CODE : undefined,
      },
      { status: isQuotaError ? 429 : 400 },
    );
  }
}
