import { NextResponse } from "next/server";
import { claimNextPromptSafetyCodexJob } from "@/lib/prompt-safety-codex-queue";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.PROMPT_SAFETY_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-prompt-safety-codex-token") === token;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function POST(request: Request) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized prompt safety Codex worker" }, { status: 401 });
  }

  try {
    const task = await claimNextPromptSafetyCodexJob({
      order: process.env.PROMPT_SAFETY_CODEX_ORDER === "oldest" ? "oldest" : "newest",
      runningTimeoutMs: positiveInteger(process.env.PROMPT_SAFETY_CODEX_TASK_TIMEOUT_MS, 20 * 60_000),
    });
    return NextResponse.json({ ok: true, task });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Prompt safety Codex task claim failed" },
      { status: 400 },
    );
  }
}
