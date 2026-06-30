import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveStoryboardImageToNest } from "@/lib/nest-projects-proxy";

export const runtime = "nodejs";

const RequestSchema = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
  storyboardImageUrl: z.string().min(1),
  storyboardImagePrompt: z.string().optional(),
});

const mimeExtension: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function decodeDataUrl(value: string) {
  const match = value.match(/^data:([^;,]+)(;[^,]*)?,([\s\S]*)$/);
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  const metadata = match[2] || "";
  const body = match[3] || "";
  const buffer = metadata.includes(";base64")
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body), "utf8");

  return { mimeType, buffer };
}

async function persistStoryboardImage(projectId: string, versionId: string, imageUrl: string) {
  if (!imageUrl.startsWith("data:")) return imageUrl;

  const decoded = decodeDataUrl(imageUrl);
  if (!decoded) throw new Error("Invalid storyboard image data URL");

  const maxBytes = Number(process.env.PROJECT_STORYBOARD_IMAGE_MAX_BYTES || 12 * 1024 * 1024);
  if (decoded.buffer.byteLength > maxBytes) {
    throw new Error("Storyboard image is too large to save");
  }

  const extension = mimeExtension[decoded.mimeType] || "bin";
  const relativeDir = path.join("project-assets", "storyboards");
  const absoluteDir = path.join(process.cwd(), "public", "project-assets", "storyboards");
  await mkdir(absoluteDir, { recursive: true });

  const fileName = `${projectId}-${versionId}-${randomUUID()}.${extension}`;
  await writeFile(path.join(absoluteDir, fileName), decoded.buffer);

  return `/${relativeDir.replaceAll("\\", "/")}/${fileName}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = RequestSchema.parse(await request.json());
    const storyboardImageUrl = await persistStoryboardImage(body.projectId, body.versionId, body.storyboardImageUrl);
    const save = await saveStoryboardImageToNest(request, {
      projectId: body.projectId,
      versionId: body.versionId,
      storyboardImageUrl,
      storyboardImagePrompt: body.storyboardImagePrompt,
    });

    if (!save.saved) {
      return NextResponse.json({ ok: false, error: save.reason || "Storyboard image save failed" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, save, storyboardImageUrl });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Storyboard image save failed" }, { status: 400 });
  }
}
