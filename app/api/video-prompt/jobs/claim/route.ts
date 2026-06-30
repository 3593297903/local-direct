import { NextResponse } from "next/server";
import { claimNextVideoPromptCodexJob } from "@/lib/video-prompt-codex-queue";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.VIDEO_PROMPT_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-video-prompt-codex-token") === token;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function POST(request: Request) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized video prompt Codex worker" }, { status: 401 });
  }

  try {
    const task = await claimNextVideoPromptCodexJob({
      order: process.env.VIDEO_PROMPT_CODEX_ORDER === "oldest" ? "oldest" : "newest",
      runningTimeoutMs: positiveInteger(process.env.VIDEO_PROMPT_CODEX_TASK_TIMEOUT_MS, 20 * 60_000),
    });
    return NextResponse.json({ ok: true, task });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Video prompt Codex task claim failed" },
      { status: 400 },
    );
  }
}
