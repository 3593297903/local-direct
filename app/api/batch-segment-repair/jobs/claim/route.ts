import { NextResponse } from "next/server";
import { claimNextBatchSegmentRepairCodexJob } from "@/lib/batch-segment-repair-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.BATCH_SEGMENT_REPAIR_CODEX_WORKER_TOKEN;
  return !token || request.headers.get("x-batch-segment-repair-codex-token") === token;
}

export async function POST(request: Request) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized batch segment repair worker" }, { status: 401 });
  }
  try {
    if (/^(1|true|yes|on)$/i.test(process.env.CODEX_FILE_QUEUE_CLAIMS_PAUSED || "")) {
      return NextResponse.json({ ok: true, task: null, claimsPaused: true });
    }
    const codexState = await getCodexRuntimeState();
    if (!codexState.available) return NextResponse.json({ ok: true, task: null, codexUnavailable: codexState });
    const task = await claimNextBatchSegmentRepairCodexJob({
      order: process.env.BATCH_SEGMENT_REPAIR_CODEX_ORDER === "newest" ? "newest" : "oldest",
      runningTimeoutMs: Number.parseInt(process.env.BATCH_SEGMENT_REPAIR_CODEX_TASK_TIMEOUT_MS || "1200000", 10),
      workerId: request.headers.get("x-worker-id") || undefined,
    });
    return NextResponse.json({ ok: true, task });
  } catch (error: any) {
    return fileJobRouteError(error, "Batch segment repair task claim failed");
  }
}
