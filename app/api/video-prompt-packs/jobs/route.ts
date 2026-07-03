import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createVideoPromptPackCodexJob } from "@/lib/video-prompt-pack-codex-queue";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

const SegmentSchema = z.object({
  episodeIndex: z.number().int().min(1),
  title: z.string().min(1),
  script: z.string().min(5).max(50_000),
  renderInputScript: z.string().min(5).max(50_000),
  duration: z.string().min(1),
  shotCount: z.number().int().min(1).max(12).optional(),
});

const RequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  segments: z.array(SegmentSchema).min(1).max(4),
});

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    await assertCodexRuntimeAvailable();
    const job = await createVideoPromptPackCodexJob(body);
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    const isQuotaError = error?.code === CODEX_QUOTA_EXHAUSTED_CODE || String(error?.message || "").includes(CODEX_QUOTA_EXHAUSTED_CODE);
    return NextResponse.json(
      { ok: false, error: error?.message || "Video prompt render pack Codex job creation failed", code: isQuotaError ? CODEX_QUOTA_EXHAUSTED_CODE : undefined },
      { status: isQuotaError ? 429 : 400 },
    );
  }
}
