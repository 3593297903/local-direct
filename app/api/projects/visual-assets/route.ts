import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveVisualAssetsToNest } from "@/lib/nest-projects-proxy";

export const runtime = "nodejs";

const VisualAssetSchema = z.object({
  type: z.enum(["SHOT_STORYBOARD", "CHARACTER_TURNAROUND", "SCENE_KEYART", "PROP_SHEET"]),
  name: z.string().min(1),
  shotId: z.string().uuid().nullable().optional(),
  shotNumber: z.number().int().positive().nullable().optional(),
  prompt: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED"]).nullable().optional(),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const RequestSchema = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
  visualAssets: z.array(VisualAssetSchema).min(1).max(80),
});

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    const save = await saveVisualAssetsToNest(request, body);

    if (!save.saved) {
      return NextResponse.json({ ok: false, error: save.reason || "Visual asset save failed" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, save });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Visual asset save failed" }, { status: 400 });
  }
}
