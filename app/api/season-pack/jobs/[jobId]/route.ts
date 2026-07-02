import { NextResponse } from "next/server";
import { getSeasonPackCodexJob } from "@/lib/season-pack-codex-queue";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const params = await context.params;
    const job = await getSeasonPackCodexJob(params.jobId);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Season pack Codex job not found" },
      { status: 404 },
    );
  }
}
