import { NextResponse } from "next/server";
import { z } from "zod";
import { completeEventCoverageCodexJob } from "@/lib/event-coverage-codex-queue";

export const runtime = "nodejs";
const BodySchema = z.object({ leaseId: z.string().min(1).max(200) });

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const { jobId } = await context.params;
    const { leaseId } = BodySchema.parse(await request.json());
    return NextResponse.json({ ok: true, job: await completeEventCoverageCodexJob(jobId, leaseId) });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Event coverage judge completion failed" }, { status: 400 });
  }
}

function isAuthorized(request: Request) {
  const expected = process.env.EVENT_COVERAGE_CODEX_WORKER_TOKEN;
  return !expected || request.headers.get("x-event-coverage-codex-token") === expected;
}
