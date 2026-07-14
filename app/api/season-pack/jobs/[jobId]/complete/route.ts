import { NextResponse } from "next/server";
import { z } from "zod";
import { completeSeasonPackCodexJob } from "@/lib/season-pack-codex-queue";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

const ResultRefSchema = z.object({
  protocolVersion: z.literal(2),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  relativePath: z.string().min(1),
  manifestRelativePath: z.string().min(1),
});

const RequestSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  resultRef: ResultRefSchema,
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
    const { leaseId, fencingToken, resultRef } = RequestSchema.parse(await request.json());
    const job = await completeSeasonPackCodexJob(params.jobId, leaseId, fencingToken, resultRef);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return fileJobRouteError(error, "Season pack Codex job completion failed");
  }
}
