import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveShotVisualReferencesToNest } from "@/lib/nest-projects-proxy";

export const runtime = "nodejs";

const ShotVisualReferenceSchema = z.object({
  shotId: z.string().uuid().nullable().optional(),
  shotNumber: z.number().int().positive().nullable().optional(),
  entityId: z.string().uuid(),
  role: z.enum(["SUBJECT", "BACKGROUND", "PROP", "STYLE"]).nullable().optional(),
  order: z.number().int().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const RequestSchema = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
  visualReferences: z.array(ShotVisualReferenceSchema).min(1).max(160),
});

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    const save = await saveShotVisualReferencesToNest(request, body);

    if (!save.saved) {
      return NextResponse.json({ ok: false, error: save.reason || "Visual reference save failed" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, save });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Visual reference save failed" }, { status: 400 });
  }
}
