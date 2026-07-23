import { NextResponse } from "next/server";
import { claimNextEventCoverageCodexJob } from "@/lib/event-coverage-codex-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const task = await claimNextEventCoverageCodexJob({
      order: process.env.EVENT_COVERAGE_CODEX_ORDER === "newest" ? "newest" : "oldest",
      runningTimeoutMs: Number(process.env.EVENT_COVERAGE_CODEX_RUNNING_TIMEOUT_MS || 20 * 60_000),
    });
    return NextResponse.json({ ok: true, task });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Event coverage judge claim failed" }, { status: 500 });
  }
}

function isAuthorized(request: Request) {
  const expected = process.env.EVENT_COVERAGE_CODEX_WORKER_TOKEN;
  return !expected || request.headers.get("x-event-coverage-codex-token") === expected;
}
