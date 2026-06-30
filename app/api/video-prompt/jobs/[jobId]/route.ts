import { NextResponse } from "next/server";
import { getVideoPromptCodexJob } from "@/lib/video-prompt-codex-queue";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    const job = await getVideoPromptCodexJob(params.jobId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Video prompt Codex job not found" },
      { status: 404 },
    );
  }
}
