import type { KnowledgeItem } from "@/types";

function copyIdPart(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function nextCopyName(name: string, items: KnowledgeItem[]) {
  const baseName = `${name || "素材"} 副本`;
  const existingNames = new Set(items.map((item) => item.name));
  if (!existingNames.has(baseName)) return baseName;

  let index = 2;
  while (existingNames.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}

export function createKnowledgeItemCopyDraft(item: KnowledgeItem, items: KnowledgeItem[], now = Date.now()) {
  return {
    ...item,
    id: `copy-${copyIdPart(item.id || item.name) || "item"}-${now}`,
    name: nextCopyName(item.name, items),
    order: undefined,
  };
}
