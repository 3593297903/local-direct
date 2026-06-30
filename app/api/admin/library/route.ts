import { NextResponse } from "next/server";
import type { KnowledgeItem, KnowledgeType } from "@/types";
import { isAdminRequestAuthorized } from "@/lib/admin-auth";
import {
  deleteLocalKnowledgeItem,
  deleteLocalKnowledgeItems,
  deletePreviewFile,
  deletePreviewFileWhenUnused,
  getMergedKnowledgeItems,
  MAX_PREVIEW_UPLOAD_BYTES,
  readLocalKnowledgeItems,
  savePreviewBuffer,
  upsertLocalKnowledgeItem,
} from "@/lib/library-store";
import { createRequestId, durationSince, logger } from "@/lib/logger";

export const runtime = "nodejs";

function parseTags(value: FormDataEntryValue | null) {
  return String(value || "")
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .toLowerCase();
}

function bytesToMB(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1);
}

type ParsedUploadFile = {
  buffer: Buffer;
  name: string;
  size: number;
  type: string;
};

function getMultipartBoundary(contentType: string) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] || match?.[2] || "";
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function parseContentDisposition(value: string) {
  const name = value.match(/(?:^|;\s*)name="([^"]*)"/i)?.[1] || "";
  const filename = value.match(/(?:^|;\s*)filename="([^"]*)"/i)?.[1] || "";
  return { name, filename };
}

async function parseMultipartRequest(request: Request, contentType: string) {
  const boundary = getMultipartBoundary(contentType);
  if (!boundary) throw new Error("上传请求缺少 boundary，请重新选择文件后再保存。");

  const body = Buffer.from(await request.arrayBuffer());
  const expectedLength = Number(request.headers.get("content-length") || 0);
  if (expectedLength > 0 && body.length < expectedLength) {
    throw new Error("上传文件没有完整到达服务器，请重启开发服务器后重新选择文件上传。");
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map<string, string>();
  let file: ParsedUploadFile | null = null;

  for (const rawPart of splitBuffer(body, delimiter)) {
    let part = rawPart;
    if (part.length === 0) continue;
    if (part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const headerLines = part.subarray(0, headerEnd).toString("utf8").split("\r\n");
    const content = part.subarray(headerEnd + 4);
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }

    const disposition = headers.get("content-disposition") || "";
    const { name, filename } = parseContentDisposition(disposition);
    if (!name) continue;

    if (filename) {
      file = {
        buffer: content,
        name: filename,
        size: content.length,
        type: headers.get("content-type") || "",
      };
    } else {
      fields.set(name, content.toString("utf8"));
    }
  }

  return { fields, file };
}

function getField(fields: Map<string, string>, key: string) {
  return fields.get(key) || "";
}

export async function GET(request: Request) {
  const requestId = createRequestId("admin_library");
  const startedAt = Date.now();
  const route = "/api/admin/library";
  logger.info("api_request_started", { requestId, route, method: "GET" });
  if (!isAdminRequestAuthorized(request)) {
    logger.warn("admin_library_unauthorized", { requestId, route, method: "GET" });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const items = await getMergedKnowledgeItems();
  const localItems = await readLocalKnowledgeItems();
  logger.info("api_request_completed", {
    requestId,
    route,
    method: "GET",
    durationMs: durationSince(startedAt),
    itemCount: items.length,
    localItemCount: localItems.length,
  });
  return NextResponse.json({ ok: true, items, localItems });
}

export async function POST(request: Request) {
  const requestId = createRequestId("admin_library");
  const startedAt = Date.now();
  const route = "/api/admin/library";
  let uploadedPreviewUrl = "";
  try {
    logger.info("api_request_started", { requestId, route, method: "POST" });
    if (!isAdminRequestAuthorized(request)) {
      logger.warn("admin_library_unauthorized", { requestId, route, method: "POST" });
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      logger.warn("admin_library_invalid_upload_content_type", { requestId, route, contentType });
      return NextResponse.json(
        { ok: false, error: "上传请求格式不正确，请重新选择文件后再保存。" },
        { status: 400 },
      );
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    const maxRequestBytes = MAX_PREVIEW_UPLOAD_BYTES + 1024 * 1024;
    if (contentLength > maxRequestBytes) {
      logger.warn("admin_library_upload_too_large", {
        requestId,
        route,
        contentLength,
        maxRequestBytes,
      });
      return NextResponse.json(
        {
          ok: false,
          error: `文件太大，当前请求约 ${bytesToMB(contentLength)}MB，最大支持 ${bytesToMB(MAX_PREVIEW_UPLOAD_BYTES)}MB。请压缩视频或换一个更短的视频后再上传。`,
        },
        { status: 413 },
      );
    }

    let parsed: Awaited<ReturnType<typeof parseMultipartRequest>>;
    try {
      parsed = await parseMultipartRequest(request, contentType);
    } catch (error) {
      logger.warn("admin_library_multipart_parse_failed", {
        requestId,
        route,
        durationMs: durationSince(startedAt),
        error,
      });
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "上传内容解析失败，请重新选择文件后再试。" },
        { status: 400 },
      );
    }

    const { fields, file } = parsed;
    logger.info("admin_library_save_started", {
      requestId,
      route,
      itemId: getField(fields, "id") || undefined,
      type: getField(fields, "type") || undefined,
      hasPreviewFile: Boolean(file && file.size > 0),
      previewFileSize: file?.size,
      previewFileType: file?.type,
    });
    const existingItems = await getMergedKnowledgeItems();
    const existing = existingItems.find((item) => item.id === getField(fields, "id"));

    let preview: { previewUrl: string; previewMimeType: string; posterUrl?: string } = {
      previewUrl: getField(fields, "previewUrl") || existing?.previewUrl || "",
      previewMimeType: getField(fields, "previewMimeType") || existing?.previewMimeType || "",
      posterUrl: getField(fields, "posterUrl") || existing?.posterUrl || "",
    };

    if (file && file.size > 0) {
      preview = await savePreviewBuffer(file.buffer, file.name, file.type);
      uploadedPreviewUrl = preview.previewUrl;
    }

    const name = String(getField(fields, "name") || existing?.name || "").trim();
    if (!name) {
      logger.warn("admin_library_missing_name", { requestId, route });
      return NextResponse.json({ ok: false, error: "名称不能为空" }, { status: 400 });
    }

    const item: KnowledgeItem = {
      id: String(getField(fields, "id") || existing?.id || slugify(name) || `item-${Date.now()}`),
      type: String(getField(fields, "type") || existing?.type || "transition") as KnowledgeType,
      category: String(getField(fields, "category") || existing?.category || "自定义"),
      name,
      description: String(getField(fields, "description") || existing?.description || ""),
      prompt: String(getField(fields, "prompt") || existing?.prompt || ""),
      tags: parseTags(getField(fields, "tags")),
      genre: String(getField(fields, "genre") || existing?.genre || "剧情"),
      stability: Number(getField(fields, "stability") || existing?.stability || 90),
      order: Number(getField(fields, "order") || existing?.order || 0) || undefined,
      useCase: String(getField(fields, "useCase") || existing?.useCase || ""),
      avoid: String(getField(fields, "avoid") || existing?.avoid || ""),
      previewType: existing?.previewType || "camera",
      previewUrl: preview.previewUrl || undefined,
      previewMimeType: preview.previewMimeType || undefined,
      posterUrl: preview.posterUrl || undefined,
    };

    const savedItem = await upsertLocalKnowledgeItem(item);
    if (existing?.previewUrl && uploadedPreviewUrl && existing.previewUrl !== uploadedPreviewUrl) {
      await deletePreviewFileWhenUnused(existing.previewUrl, await getMergedKnowledgeItems());
    }
    logger.info("api_request_completed", {
      requestId,
      route,
      method: "POST",
      durationMs: durationSince(startedAt),
      itemId: savedItem.id,
      type: savedItem.type,
      order: savedItem.order,
      uploadedPreview: Boolean(uploadedPreviewUrl),
    });
    return NextResponse.json({ ok: true, item: savedItem, items: await getMergedKnowledgeItems() });
  } catch (error: any) {
    logger.error("api_request_failed", {
      requestId,
      route,
      method: "POST",
      durationMs: durationSince(startedAt),
      uploadedPreviewUrl,
      error,
    });
    if (uploadedPreviewUrl) await deletePreviewFile(uploadedPreviewUrl).catch(() => {});
    return NextResponse.json(
      { ok: false, error: error?.message || "上传保存失败，请检查文件大小、格式或服务端日志。" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const requestId = createRequestId("admin_library");
  const startedAt = Date.now();
  const route = "/api/admin/library";
  logger.info("api_request_started", { requestId, route, method: "DELETE" });
  if (!isAdminRequestAuthorized(request)) {
    logger.warn("admin_library_unauthorized", { requestId, route, method: "DELETE" });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const ids = (searchParams.get("ids") || searchParams.get("id") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  logger.info("admin_library_delete_requested", { requestId, route, idCount: ids.length });
  if (ids.length === 0) {
    logger.warn("admin_library_delete_missing_id", { requestId, route });
    return NextResponse.json({ ok: false, error: "缺少素材 ID" }, { status: 400 });
  }

  const result = ids.length === 1 ? await deleteLocalKnowledgeItem(ids[0]) : await deleteLocalKnowledgeItems(ids);
  const deleted = Array.isArray(result.deleted) ? result.deleted : result.deleted ? [result.deleted] : [];
  if (deleted.length === 0) {
    logger.warn("admin_library_delete_not_found", { requestId, route, idCount: ids.length });
    return NextResponse.json({ ok: false, error: "没有找到可删除的本地素材" }, { status: 404 });
  }

  logger.info("api_request_completed", {
    requestId,
    route,
    method: "DELETE",
    durationMs: durationSince(startedAt),
    requestedCount: ids.length,
    deletedCount: deleted.length,
    deletedTypes: Array.from(new Set(deleted.map((item) => item.type))),
  });
  return NextResponse.json({ ok: true, deleted, items: await getMergedKnowledgeItems() });
}
