import { NextResponse } from "next/server";
import { z } from "zod";
import { failEventCoverageCodexJob } from "@/lib/event-coverage-codex-queue";
import { isCodexQuotaExhaustedMessage, markCodexQuotaExhausted } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";
const BodySchema = z.object({ leaseId: z.string().min(1).max(200), message: z.string().max(4_000).optional() });

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const { jobId } = await context.params;
    const body = BodySchema.parse(await request.json());
    if (isCodexQuotaExhaustedMessage(body.message)) {
      await markCodexQuotaExhausted("event-coverage", body.message);
    }
    return NextResponse.json({ ok: true, job: await failEventCoverageCodexJob(jobId, body.leaseId, body.message) });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Event coverage judge failure update failed" }, { status: 400 });
  }
}

function isAuthorized(request: Request) {
  const expected = process.env.EVENT_COVERAGE_CODEX_WORKER_TOKEN;
  return !expected || request.headers.get("x-event-coverage-codex-token") === expected;
}
