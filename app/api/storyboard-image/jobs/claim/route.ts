import { NextResponse } from "next/server";
import { claimNextStoryboardCodexPanel } from "@/lib/storyboard-codex-queue";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.STORYBOARD_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-storyboard-codex-token") === token;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function POST(request: Request) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized storyboard Codex worker" }, { status: 401 });
  }

  try {
    const task = await claimNextStoryboardCodexPanel({
      order: process.env.STORYBOARD_CODEX_ORDER === "oldest" ? "oldest" : "newest",
      runningTimeoutMs: positiveInteger(process.env.STORYBOARD_CODEX_TASK_TIMEOUT_MS, 30 * 60_000),
    });
    return NextResponse.json({ ok: true, task });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Storyboard Codex task claim failed" },
      { status: 400 },
    );
  }
}
