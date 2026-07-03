import { NextResponse } from "next/server";
import { failVisualAssetCodexJob, getVisualAssetCodexJob } from "@/lib/visual-asset-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    let job = await getVisualAssetCodexJob(jobId);
    const codexState = await getCodexRuntimeState();
    if (!codexState.available && job.status !== "completed" && job.status !== "failed") {
      job = await failVisualAssetCodexJob(jobId, codexState.message || "Codex is unavailable");
    }
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Visual asset Codex job lookup failed" },
      { status: 404 },
    );
  }
}
