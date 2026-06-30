import type { KnowledgeItem } from "@/types";

export const knowledgeItems: KnowledgeItem[] = [];

export function searchKnowledge(query: string, type?: KnowledgeItem["type"]) {
  const q = query.trim().toLowerCase();
  return knowledgeItems.filter((item) => {
    const typeMatch = !type || item.type === type;
    if (!q) return typeMatch;
    const haystack = [item.name, item.category, item.description, item.prompt, item.tags.join(" ")]
      .join(" ")
      .toLowerCase();
    return typeMatch && haystack.includes(q);
  });
}

export function recommendKnowledge(script: string) {
  const text = script.toLowerCase();
  const tags: string[] = [];
  if (/雨|夜|恐怖|悬疑|秘密|废弃|黑|死亡/.test(text)) tags.push("#悬疑", "#黑场", "#特写");
  if (/回忆|过去|照片|梦/.test(text)) tags.push("#回忆", "#光影");
  if (/产品|购买|广告|用户|卖点/.test(text)) tags.push("#高级感", "#稳定");
  return knowledgeItems.filter((item) => item.tags.some((tag) => tags.includes(tag))).slice(0, 6);
}
