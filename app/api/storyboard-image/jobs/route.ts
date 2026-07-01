import { NextResponse } from "next/server";
import { z } from "zod";
import { createStoryboardCodexJob } from "@/lib/storyboard-codex-queue";

export const runtime = "nodejs";

const ShotSchema = z.object({
  shotNumber: z.coerce.number(),
  scene: z.string().optional(),
  visual: z.string().optional(),
  shotType: z.string().optional(),
  composition: z.string().optional(),
  cameraMovement: z.string().optional(),
  lighting: z.string().optional(),
  sound: z.string().optional(),
  dialogue: z.string().optional(),
  emotion: z.string().optional(),
  transition: z.string().optional(),
  shotPurpose: z.string().optional(),
  videoPrompt: z.string().optional(),
  negativePrompt: z.string().optional(),
});

const RequestSchema = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
  title: z.string().min(1).default("AI 视频分镜图"),
  style: z.string().min(1).default("16:9 彩色电影级分镜图，电影光影，写实概念美术"),
  storyboard: z.array(ShotSchema).min(1).max(8),
  size: z.string().optional(),
  quality: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const body = RequestSchema.parse(await request.json());
    const job = await createStoryboardCodexJob(body);
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Storyboard Codex job creation failed" },
      { status: 400 },
    );
  }
}
