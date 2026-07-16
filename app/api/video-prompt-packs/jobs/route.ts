import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createVideoPromptPackCodexJob,
  toVideoPromptPackCodexJobStatusDto,
} from "@/lib/video-prompt-pack-codex-queue";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";
import type { SegmentContract } from "@/lib/batch-segment-contract";
import { fileJobRouteError } from "@/lib/file-job-route-error";
import {
  assertCodexFinalizationV2CreateEnabled,
  CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE,
} from "@/lib/codex-job-finalization";

export const runtime = "nodejs";

const SegmentSchema = z.object({
  episodeIndex: z.number().int().min(1),
  title: z.string().min(1),
  script: z.string().min(5).max(50_000),
  renderInputScript: z.string().min(5).max(50_000),
  duration: z.string().min(1),
  shotCount: z.number().int().min(1).max(12).optional(),
  segmentContract: z.custom<SegmentContract>(
    (value) => value === undefined || (Boolean(value) && typeof value === "object" && !Array.isArray(value)),
    "segmentContract must be an object",
  ).optional(),
});

const RequestSchema = z.object({
  batchId: z.string().min(1).max(240).regex(/^[A-Za-z0-9._:-]+$/),
  operationToken: z.string().min(1).max(240).regex(/^[A-Za-z0-9._:-]+$/),
  idempotencyKey: z.string().min(1).max(400),
  projectId: z.string().uuid().optional(),
  mode: z.enum(["standard", "strictUtf8"]).optional(),
  coverageSidecarEnabled: z.boolean().optional(),
  segments: z.array(SegmentSchema).min(1).max(5),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    assertCodexFinalizationV2CreateEnabled();
    await assertCodexRuntimeAvailable();
    const job = await createVideoPromptPackCodexJob(body);
    return NextResponse.json({ ok: true, job: toVideoPromptPackCodexJobStatusDto(job) }, { status: 201 });
  } catch (error: any) {
    if (error?.code === CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE) {
      return NextResponse.json(
        { ok: false, code: CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE, errorCode: CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE, error: error.message },
        { status: 503 },
      );
    }
    const isQuotaError = error?.code === CODEX_QUOTA_EXHAUSTED_CODE || String(error?.message || "").includes(CODEX_QUOTA_EXHAUSTED_CODE);
    if (isQuotaError) {
      return NextResponse.json(
        { ok: false, error: error?.message || "Codex is unavailable", code: CODEX_QUOTA_EXHAUSTED_CODE },
        { status: 429 },
      );
    }
    return fileJobRouteError(error, "Video prompt render pack Codex job creation failed");
  }
}
