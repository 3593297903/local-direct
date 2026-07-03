import { NextResponse } from "next/server";
import { z } from "zod";
import { completeVisualAssetCodexTask } from "@/lib/visual-asset-codex-queue";

export const runtime = "nodejs";

const RequestSchema = z.object({
  sourceImagePath: z.string().nullable().optional(),
  codexLogPath: z.string().nullable().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const body = RequestSchema.parse(await request.json().catch(() => ({})));
    const job = await completeVisualAssetCodexTask(jobId, {
      sourceImagePath: body.sourceImagePath || null,
      codexLogPath: body.codexLogPath || null,
    });
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Visual asset Codex task completion failed" },
      { status: 400 },
    );
  }
}
