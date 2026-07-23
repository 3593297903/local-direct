import { NextResponse } from "next/server";
import { readCodexRuntimeHealth } from "@/lib/codex-runtime-health";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const workerName = new URL(request.url).searchParams.get("worker") || "season-pack";
  try {
    const health = await readCodexRuntimeHealth(workerName);
    if (health.status === "healthy") return NextResponse.json({ ok: true, health });
    if (health.status === "invalid") {
      return NextResponse.json({
        ok: false,
        code: "CODEX_SKILL_CONFIG_INVALID",
        error: "Codex Skill 配置无效，请修复后重启 worker。",
        errors: health.environment?.errors || [],
        health,
      }, { status: 503 });
    }
    return NextResponse.json({
      ok: false,
      code: "CODEX_WORKER_UNAVAILABLE",
      error: health.status === "stale" ? "本地 Codex worker 心跳已过期，请重启 worker。" : "本地 Codex worker 尚未运行。",
      health,
    }, { status: 503 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: "CODEX_RUNTIME_HEALTH_FAILED",
      error: error instanceof Error ? error.message : "Codex runtime health check failed",
    }, { status: 500 });
  }
}
