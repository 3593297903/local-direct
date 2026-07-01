import { NextResponse } from "next/server";
import { getPromptSafetyCodexJob } from "@/lib/prompt-safety-codex-queue";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    const job = await getPromptSafetyCodexJob(params.jobId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Prompt safety Codex job not found" },
      { status: 404 },
    );
  }
}
