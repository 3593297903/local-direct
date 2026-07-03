import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createVideoPromptCodexJob } from "@/lib/video-prompt-codex-queue";
import { fetchDirectorContextFromNest } from "@/lib/nest-projects-proxy";

export const runtime = "nodejs";

const RequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
  script: z.string().min(5).max(50_000),
  contentType: z.string().optional(),
  style: z.string().optional(),
  duration: z.string().optional(),
  projectMemory: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    const projectMemory = body.projectMemory || await fetchDirectorContextFromNest(request, body.projectId, body.script);
    const job = await createVideoPromptCodexJob({ ...body, projectMemory });
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Video prompt Codex job creation failed" },
      { status: 400 },
    );
  }
}
