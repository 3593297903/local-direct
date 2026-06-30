import { NextResponse } from "next/server";
import { extractDocxText } from "@/lib/docx-text";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "请上传 txt 或 docx 文案文件" }, { status: 400 });
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: "文件太大，请上传 8MB 以内的 txt 或 docx" }, { status: 400 });
    }

    const name = file.name || "copy";
    const ext = name.toLowerCase().split(".").pop();
    let text = "";

    if (ext === "txt") {
      text = await file.text();
    } else if (ext === "docx") {
      text = extractDocxText(Buffer.from(await file.arrayBuffer()));
    } else {
      return NextResponse.json({ ok: false, error: "只支持 txt 和 docx 文案文件" }, { status: 400 });
    }

    const normalized = text.replace(/\r\n?/g, "\n").trim();
    if (!normalized) {
      return NextResponse.json({ ok: false, error: "没有从文件中读取到正文" }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      filename: name,
      text: normalized,
      characterCount: normalized.length,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "文案文件解析失败" }, { status: 400 });
  }
}
