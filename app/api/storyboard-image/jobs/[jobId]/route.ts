import { NextResponse } from "next/server";
import { getStoryboardCodexJob } from "@/lib/storyboard-codex-queue";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    const job = await getStoryboardCodexJob(params.jobId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Storyboard Codex job not found" },
      { status: 404 },
    );
  }
}
