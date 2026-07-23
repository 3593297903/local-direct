import { NextResponse } from "next/server";
import { getEventCoverageCodexJob } from "@/lib/event-coverage-codex-queue";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    return NextResponse.json({ ok: true, job: await getEventCoverageCodexJob(jobId) });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Event coverage judge job not found" }, { status: 404 });
  }
}
