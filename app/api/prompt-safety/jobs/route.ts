import { NextResponse } from "next/server";
import { z } from "zod";
import { createPromptSafetyCodexJob } from "@/lib/prompt-safety-codex-queue";

export const runtime = "nodejs";

const RequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
  targetModel: z.string().optional(),
  promptText: z.string().min(5).max(120_000),
  sourceResult: z.record(z.string(), z.unknown()),
});

export async function POST(request: Request) {
  try {
    const body = RequestSchema.parse(await request.json());
    const job = await createPromptSafetyCodexJob(body);
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Prompt safety Codex job creation failed" },
      { status: 400 },
    );
  }
}
