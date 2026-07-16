import { NextResponse } from "next/server";
import { z } from "zod";
import { completeVideoPromptPackCodexJob } from "@/lib/video-prompt-pack-codex-queue";
import { fileJobRouteError } from "@/lib/file-job-route-error";

export const runtime = "nodejs";

const RequestSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  resultRef: z.object({
    protocolVersion: z.literal(2),
    resultHash: z.string().regex(/^[a-f0-9]{64}$/),
    relativePath: z.string().min(1),
    manifestRelativePath: z.string().min(1),
  }),
});

function isWorkerAuthorized(request: Request) {
  const token = process.env.VIDEO_PROMPT_PACK_CODEX_WORKER_TOKEN;
  if (!token) return true;
  return request.headers.get("x-video-prompt-pack-codex-token") === token;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isWorkerAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized video prompt render pack Codex worker" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const { leaseId, fencingToken, resultRef } = RequestSchema.parse(await request.json());
    const job = await completeVideoPromptPackCodexJob(params.jobId, leaseId, fencingToken, resultRef);
    return NextResponse.json({ ok: true, job });
  } catch (error: any) {
    return fileJobRouteError(error, "Video prompt render pack Codex job completion failed");
  }
}

