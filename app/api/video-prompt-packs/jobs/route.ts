import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createVideoPromptPackCodexJob,
  toVideoPromptPackCodexJobStatusDto,
} from "@/lib/video-prompt-pack-codex-queue";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";
import type { SegmentContract } from "@/lib/batch-segment-contract";
import { fileJobRouteError } from "@/lib/file-job-route-error";

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
  idempotencyKey: z.string().min(1).max(400).optional(),
  projectId: z.string().uuid().optional(),
  mode: z.enum(["standard", "strictUtf8"]).optional(),
  coverageSidecarEnabled: z.boolean().optional(),
  segments: z.array(SegmentSchema).min(1).max(5),
});

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    await assertCodexRuntimeAvailable();
    const job = await createVideoPromptPackCodexJob(body);
    return NextResponse.json({ ok: true, job: toVideoPromptPackCodexJobStatusDto(job) }, { status: 201 });
  } catch (error: any) {
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
