import { NextResponse } from "next/server";
import { z } from "zod";
import { failSeasonPackCodexJob } from "@/lib/season-pack-codex-queue";
import { isCodexQuotaExhaustedMessage, markCodexQuotaExhausted } from "@/lib/codex-runtime-state";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

const RequestSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  message: z.string().max(10_000).optional(),
  errorCode: z.string().min(1).max(100).optional(),
});

function isWorkerAuthorized(request: Request) {
  const token = process.env.SEASON_PACK_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-season-pack-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized season pack Codex worker" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const { leaseId, fencingToken, message, errorCode } = RequestSchema.parse(await request.json());
    if (isCodexQuotaExhaustedMessage(message)) {
      await markCodexQuotaExhausted("season-pack", message);
    }
    const job = await failSeasonPackCodexJob(params.jobId, leaseId, fencingToken, message, errorCode);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return fileJobRouteError(error, "Season pack Codex job failure update failed");
  }
}
