import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { knowledgeItems } from "./knowledge";
import type { KnowledgeItem, KnowledgeType } from "@/types";

const execFileAsync = promisify(execFile);

const allowedExtensions = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

export const MAX_PREVIEW_UPLOAD_BYTES = 25 * 1024 * 1024;

function projectPath(root = process.cwd(), ...parts: string[]) {
  return path.join(root, ...parts);
}

export function localDataPath(root = process.cwd()) {
  return projectPath(root, "data", "knowledge-items.json");
}

export function previewDirPath(root = process.cwd()) {
  return projectPath(root, "public", "previews");
}

export function posterDirPath(root = process.cwd()) {
  return projectPath(root, "public", "previews", "posters");
}

export async function readLocalKnowledgeItems(root = process.cwd()): Promise<KnowledgeItem[]> {
  try {
    const raw = await readFile(localDataPath(root), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeLocalKnowledgeItems(items: KnowledgeItem[], root = process.cwd()) {
  await mkdir(path.dirname(localDataPath(root)), { recursive: true });
  await writeFile(localDataPath(root), `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function typeRank(type: KnowledgeType) {
  return ["transition", "shot", "camera_movement", "style", "storyboard_formula"].indexOf(type);
}

function orderValue(item: KnowledgeItem, fallback: number) {
  return Number.isFinite(item.order) && Number(item.order) > 0 ? Number(item.order) : fallback + 1;
}

export function sortKnowledgeItems(items: KnowledgeItem[]) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftType = typeRank(left.item.type);
      const rightType = typeRank(right.item.type);
      if (leftType !== rightType) return leftType - rightType;
      const leftOrder = orderValue(left.item, left.index);
      const rightOrder = orderValue(right.item, right.index);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

function nextOrderForType(items: KnowledgeItem[], type: KnowledgeType) {
  return items
    .filter((item) => item.type === type)
    .reduce((max, item, index) => Math.max(max, orderValue(item, index)), 0) + 1;
}

function compactOrderForTypes(items: KnowledgeItem[], types: KnowledgeType[]) {
  const typeSet = new Set(types);
  const counters = new Map<KnowledgeType, number>();
  return items.map((item) => {
    if (!typeSet.has(item.type)) return item;
    const next = (counters.get(item.type) || 0) + 1;
    counters.set(item.type, next);
    return { ...item, order: next };
  });
}

export async function getMergedKnowledgeItems(root = process.cwd()): Promise<KnowledgeItem[]> {
  const localItems = await readLocalKnowledgeItems(root);
  const merged = new Map<string, KnowledgeItem>();
  for (const item of knowledgeItems) merged.set(item.id, item);
  for (const item of localItems) merged.set(item.id, item);
  return sortKnowledgeItems(Array.from(merged.values()));
}

export function filterKnowledgeItems(items: KnowledgeItem[], query: string, type?: KnowledgeType) {
  const q = query.trim().toLowerCase();
  return sortKnowledgeItems(items.filter((item) => {
    const typeMatch = !type || item.type === type;
    if (!q) return typeMatch;
    const haystack = [item.name, item.category, item.genre || "", item.description, item.prompt, item.tags.join(" ")]
      .join(" ")
      .toLowerCase();
    return typeMatch && haystack.includes(q);
  }));
}

function basicPinyinFallback(input: string) {
  const known: Record<string, string> = {
    黑: "hei",
    影: "ying",
    转: "zhuan",
    場: "chang",
    场: "chang",
  };
  const tokens: string[] = [];
  let asciiBuffer = "";
  for (const char of Array.from(input)) {
    if (known[char]) {
      if (asciiBuffer) {
        tokens.push(asciiBuffer);
        asciiBuffer = "";
      }
      tokens.push(known[char]);
    } else {
      asciiBuffer += char;
    }
  }
  if (asciiBuffer) tokens.push(asciiBuffer);
  return tokens.join("-");
}

export function sanitizeUploadName(fileName: string) {
  const originalExtension = path.extname(fileName).toLowerCase();
  const extension = allowedExtensions.has(originalExtension) ? originalExtension : ".bin";
  if (extension === ".bin") return "preview.bin";

  const baseName = path.basename(fileName, path.extname(fileName));
  const ascii = basicPinyinFallback(baseName)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `${ascii || "preview"}${extension}`;
}

export function mimeTypeFromName(fileName: string) {
  return allowedExtensions.get(path.extname(fileName).toLowerCase()) || "application/octet-stream";
}

function isVideoFile(fileName: string, mimeType = "") {
  return mimeType.startsWith("video/") || /\.(mp4|webm)$/i.test(fileName);
}

export function validatePreviewFile(file: Pick<File, "name" | "size" | "type">) {
  const extension = path.extname(file.name).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error("只支持 JPG、PNG、WebP、GIF、MP4 或 WebM 预览文件");
  }

  if (file.size > MAX_PREVIEW_UPLOAD_BYTES) {
    throw new Error("预览文件不能超过 25MB");
  }
}

export async function savePreviewFile(file: File, root = process.cwd()) {
  validatePreviewFile(file);
  return savePreviewBuffer(Buffer.from(await file.arrayBuffer()), file.name, file.type || mimeTypeFromName(file.name), root);
}

export async function savePreviewBuffer(buffer: Buffer, fileName: string, mimeType = "", root = process.cwd()) {
  validatePreviewFile({ name: fileName, size: buffer.length, type: mimeType });
  const safeName = `${Date.now()}-${sanitizeUploadName(fileName)}`;
  await mkdir(previewDirPath(root), { recursive: true });
  const previewPath = path.join(previewDirPath(root), safeName);
  const previewMimeType = mimeType || mimeTypeFromName(safeName);
  await writeFile(previewPath, buffer);

  const previewUrl = `/previews/${safeName}`;
  const posterUrl = isVideoFile(safeName, previewMimeType) ? await saveVideoPoster(previewPath, safeName, root) : undefined;
  return {
    previewUrl,
    previewMimeType,
    posterUrl,
  };
}

export async function upsertLocalKnowledgeItem(item: KnowledgeItem, root = process.cwd()) {
  const localItems = await readLocalKnowledgeItems(root);
  const existing = localItems.find((entry) => entry.id === item.id);
  const typeChanged = Boolean(existing && existing.type !== item.type);
  const nextItems = localItems.filter((entry) => entry.id !== item.id);
  let order: number;
  if (typeChanged) {
    order = nextOrderForType(nextItems, item.type);
  } else if (Number.isFinite(item.order) && Number(item.order) > 0) {
    order = Number(item.order);
  } else {
    order = existing?.order || nextOrderForType(nextItems, item.type);
  }

  const itemWithOrder = {
    ...item,
    order,
  };
  nextItems.push(itemWithOrder);
  const sortedItems = sortKnowledgeItems(nextItems);
  const savedItems = typeChanged && existing
    ? compactOrderForTypes(sortedItems, [existing.type, item.type])
    : sortedItems;
  await writeLocalKnowledgeItems(savedItems, root);
  return savedItems.find((entry) => entry.id === item.id) || itemWithOrder;
}

function previewPathFromUrl(previewUrl: string, root = process.cwd()) {
  if (!previewUrl.startsWith("/previews/")) return "";
  const fileName = path.basename(previewUrl);
  return path.join(previewDirPath(root), fileName);
}

function posterUrlFromPreviewUrl(previewUrl: string | undefined) {
  if (!previewUrl) return "";
  const fileName = path.basename(previewUrl, path.extname(previewUrl));
  return `/previews/posters/${fileName}.jpg`;
}

function posterPathFromPreviewUrl(previewUrl: string | undefined, root = process.cwd()) {
  const posterUrl = posterUrlFromPreviewUrl(previewUrl);
  if (!posterUrl.startsWith("/previews/posters/")) return "";
  return path.join(posterDirPath(root), path.basename(posterUrl));
}

async function saveVideoPoster(previewPath: string, safeName: string, root = process.cwd()) {
  await mkdir(posterDirPath(root), { recursive: true });
  const posterName = `${path.basename(safeName, path.extname(safeName))}.jpg`;
  const posterPath = path.join(posterDirPath(root), posterName);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      "0.2",
      "-i",
      previewPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=720:-1",
      "-q:v",
      "4",
      posterPath,
    ]);
    return `/previews/posters/${posterName}`;
  } catch {
    return undefined;
  }
}

export async function deletePreviewFile(previewUrl: string | undefined, root = process.cwd()) {
  if (!previewUrl) return;
  const target = previewPathFromUrl(previewUrl, root);
  if (!target) return;
  await unlink(target).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const poster = posterPathFromPreviewUrl(previewUrl, root);
  if (poster) {
    await unlink(poster).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function isPreviewUrlReferenced(previewUrl: string | undefined, items: KnowledgeItem[]) {
  if (!previewUrl) return false;
  return items.some((item) => item.previewUrl === previewUrl);
}

export async function deletePreviewFileWhenUnused(previewUrl: string | undefined, remainingItems: KnowledgeItem[], root = process.cwd()) {
  if (isPreviewUrlReferenced(previewUrl, remainingItems)) return;
  await deletePreviewFile(previewUrl, root);
}

export async function deleteLocalKnowledgeItem(id: string, root = process.cwd()) {
  const localItems = await readLocalKnowledgeItems(root);
  const deleted = localItems.find((entry) => entry.id === id);
  const items = localItems.filter((entry) => entry.id !== id);
  if (!deleted) return { deleted: null, items: localItems };

  const compacted = compactOrderForTypes(sortKnowledgeItems(items), [deleted.type]);
  await writeLocalKnowledgeItems(compacted, root);
  await deletePreviewFileWhenUnused(deleted.previewUrl, compacted, root);
  return { deleted, items: compacted };
}

export async function deleteLocalKnowledgeItems(ids: string[], root = process.cwd()) {
  const idSet = new Set(ids);
  const localItems = await readLocalKnowledgeItems(root);
  const deleted = localItems.filter((entry) => idSet.has(entry.id));
  const items = localItems.filter((entry) => !idSet.has(entry.id));
  if (deleted.length === 0) return { deleted: [], items: localItems };

  const compacted = compactOrderForTypes(sortKnowledgeItems(items), Array.from(new Set(deleted.map((item) => item.type))));
  await writeLocalKnowledgeItems(compacted, root);
  await Promise.all(deleted.map((item) => deletePreviewFileWhenUnused(item.previewUrl, compacted, root)));
  return { deleted, items: compacted };
}
