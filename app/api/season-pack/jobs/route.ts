import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSeasonPackCodexJob } from "@/lib/season-pack-codex-queue";
import { fetchDirectorContextFromNest } from "@/lib/nest-projects-proxy";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";
import {
  assertCodexFinalizationV2CreateEnabled,
  CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE,
} from "@/lib/codex-job-finalization";

export const runtime = "nodejs";

const RequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  script: z.string().min(5).max(50_000),
  segmentCountMode: z.enum(["fixed", "auto"]).optional().default("fixed"),
  episodeCount: z.number().int().min(1).max(30).optional(),
  duration: z.string().optional(),
  contentType: z.string().optional(),
  style: z.string().optional(),
  projectMemory: z.string().optional(),
}).superRefine((value, context) => {
  if (value.segmentCountMode !== "auto" && !value.episodeCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["episodeCount"],
      message: "episodeCount is required for fixed segment count mode",
    });
  }
});

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    assertCodexFinalizationV2CreateEnabled();
    await assertCodexRuntimeAvailable();
    const projectMemory = body.projectMemory || await fetchDirectorContextFromNest(request, body.projectId, body.script);
    const job = await createSeasonPackCodexJob({ ...body, projectMemory });
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    if (error?.code === CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE) {
      return NextResponse.json(
        { ok: false, code: CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE, errorCode: CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE, error: error.message },
        { status: 503 },
      );
    }
    const isQuotaError = error?.code === CODEX_QUOTA_EXHAUSTED_CODE || String(error?.message || "").includes(CODEX_QUOTA_EXHAUSTED_CODE);
    return NextResponse.json(
      { ok: false, error: error?.message || "Season pack Codex job creation failed", code: isQuotaError ? CODEX_QUOTA_EXHAUSTED_CODE : undefined },
      { status: isQuotaError ? 429 : 400 },
    );
  }
}
