import { createPromptDocxBuffer } from "@/lib/prompt-docx";

export const runtime = "nodejs";

type PromptDocxRequest = {
  title?: string;
  sections?: Array<{
    heading?: string;
    originalText?: string;
    promptText?: string;
  }>;
};

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "ai-video-prompts";
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PromptDocxRequest;
    const sections = (body.sections || [])
      .map((section, index) => ({
        heading: section.heading || `第 ${index + 1} 段视频提示词`,
        originalText: section.originalText || "",
        promptText: section.promptText || "",
      }))
      .filter((section) => section.promptText.trim());

    if (!sections.length) {
      return Response.json({ ok: false, error: "没有可下载的提示词内容" }, { status: 400 });
    }

    const title = body.title || "AI 视频提示词";
    const buffer = createPromptDocxBuffer({ title, sections });
    const filename = `${safeFilename(title)}.docx`;

    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || "DOCX 生成失败" }, { status: 400 });
  }
}
