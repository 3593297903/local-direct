import { NextResponse } from "next/server";
import { z } from "zod";
import { createVisualAssetCodexJob } from "@/lib/visual-asset-codex-queue";
import { CODEX_QUOTA_EXHAUSTED_CODE, assertCodexRuntimeAvailable } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

const RequestSchema = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
  entityId: z.string().uuid(),
  entityType: z.enum(["CHARACTER", "SCENE", "PROP", "STYLE"]),
  entityName: z.string().min(1),
  entityKey: z.string().nullable().optional(),
  canonicalPrompt: z.string().nullable().optional(),
  visualLock: z.string().nullable().optional(),
  negativeLock: z.string().nullable().optional(),
  mode: z.enum(["initial", "regenerate", "edit_text", "edit_image"]).nullable().optional(),
  editInstruction: z.string().nullable().optional(),
  referenceImageUrl: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  quality: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const body = RequestSchema.parse(await request.json());
    await assertCodexRuntimeAvailable();
    const job = await createVisualAssetCodexJob({
      ...body,
      entityKey: body.entityKey || undefined,
      canonicalPrompt: body.canonicalPrompt || undefined,
      visualLock: body.visualLock || undefined,
      negativeLock: body.negativeLock || undefined,
      mode: body.mode || undefined,
      editInstruction: body.editInstruction || undefined,
      referenceImageUrl: body.referenceImageUrl || undefined,
      size: body.size || undefined,
      quality: body.quality || undefined,
    });
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    const isQuotaError = error?.code === CODEX_QUOTA_EXHAUSTED_CODE || String(error?.message || "").includes(CODEX_QUOTA_EXHAUSTED_CODE);
    return NextResponse.json(
      { ok: false, error: error?.message || "Visual asset Codex job creation failed", code: isQuotaError ? CODEX_QUOTA_EXHAUSTED_CODE : undefined },
      { status: isQuotaError ? 429 : 400 },
    );
  }
}
