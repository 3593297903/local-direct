import { NextResponse } from "next/server";
import { claimNextVisualAssetCodexTask } from "@/lib/visual-asset-codex-queue";
import { getCodexRuntimeState } from "@/lib/codex-runtime-state";

export const runtime = "nodejs";

function isWorkerAuthorized(request: Request) {
  const token = process.env.VISUAL_ASSET_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-visual-asset-codex-token") === token;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function POST(request: Request) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized visual asset Codex worker" }, { status: 401 });
  }

  try {
    const codexState = await getCodexRuntimeState();
    if (!codexState.available) {
      return NextResponse.json({ ok: true, task: null, codexUnavailable: codexState });
    }
    const task = await claimNextVisualAssetCodexTask({
      order: process.env.VISUAL_ASSET_CODEX_ORDER === "newest" ? "newest" : "oldest",
      runningTimeoutMs: positiveInteger(process.env.VISUAL_ASSET_CODEX_TASK_TIMEOUT_MS, 30 * 60_000),
    });
    return NextResponse.json({ ok: true, task });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Visual asset Codex task claim failed" },
      { status: 400 },
    );
  }
}
