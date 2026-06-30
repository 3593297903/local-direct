import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveProjectVisualEntitiesToNest } from "@/lib/nest-projects-proxy";

export const runtime = "nodejs";

const ProjectVisualEntitySchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(["CHARACTER", "SCENE", "PROP", "STYLE"]),
  key: z.string().nullable().optional(),
  name: z.string().min(1),
  aliases: z.array(z.string()).nullable().optional(),
  canonicalPrompt: z.string().nullable().optional(),
  visualLock: z.string().nullable().optional(),
  negativeLock: z.string().nullable().optional(),
  status: z.enum(["CANDIDATE", "APPROVED", "LOCKED", "ARCHIVED"]).nullable().optional(),
  primaryAssetId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const RequestSchema = z.object({
  projectId: z.string().uuid(),
  visualEntities: z.array(ProjectVisualEntitySchema).min(1).max(80),
});

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    const save = await saveProjectVisualEntitiesToNest(request, body);

    if (!save.saved) {
      return NextResponse.json({ ok: false, error: save.reason || "Visual entity save failed" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, save });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Visual entity save failed" }, { status: 400 });
  }
}
