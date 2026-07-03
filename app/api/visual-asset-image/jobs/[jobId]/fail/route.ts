import { NextResponse } from "next/server";
import { z } from "zod";
import { CODEX_QUOTA_EXHAUSTED_CODE, markCodexQuotaExhausted } from "@/lib/codex-runtime-state";
import { failVisualAssetCodexJob, failVisualAssetCodexTask } from "@/lib/visual-asset-codex-queue";

export const runtime = "nodejs";

const RequestSchema = z.object({
  message: z.string().min(1).default("Visual asset Codex task failed"),
});

function isQuotaMessage(message: string) {
  return message.includes(CODEX_QUOTA_EXHAUSTED_CODE);
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const body = RequestSchema.parse(await request.json().catch(() => ({})));
    const message = body.message || "Visual asset Codex task failed";
    if (isQuotaMessage(message)) {
      await markCodexQuotaExhausted("visual-asset-codex-worker", message);
      const job = await failVisualAssetCodexJob(jobId, message);
      return NextResponse.json({ ok: true, job, code: CODEX_QUOTA_EXHAUSTED_CODE });
    }

    const job = await failVisualAssetCodexTask(jobId, message);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Visual asset Codex task failure report failed" },
      { status: 400 },
    );
  }
}
