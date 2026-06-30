import type { KnowledgeItem, StoryboardShot } from "@/types";

export type ShotReferenceMatches = {
  shot: KnowledgeItem[];
  camera: KnowledgeItem[];
  transition: KnowledgeItem[];
};

type MatchRule = {
  canonical: string;
  aliases: string[];
};

const shotRules: MatchRule[] = [
  { canonical: "大特写", aliases: ["大特写", "极特写", "超特写"] },
  { canonical: "特写", aliases: ["特写", " close-up", "close up"] },
  { canonical: "近景", aliases: ["近景", "中近景"] },
  { canonical: "中景", aliases: ["中景", "半身"] },
  { canonical: "全景", aliases: ["全景", "全身"] },
  { canonical: "大远景", aliases: ["大远景", "极远景"] },
  { canonical: "远景", aliases: ["远景"] },
  { canonical: "主观镜头", aliases: ["主观", "第一视角", "pov"] },
  { canonical: "过肩镜头", aliases: ["过肩", "肩后"] },
  { canonical: "俯拍", aliases: ["俯拍", "高角度"] },
  { canonical: "仰拍", aliases: ["仰拍", "低角度"] },
  { canonical: "空镜", aliases: ["空镜", "环境镜头"] },
];

const cameraRules: MatchRule[] = [
  { canonical: "快速甩镜", aliases: ["快速甩镜", "甩镜", "whip"] },
  { canonical: "缓慢推进", aliases: ["缓慢推进", "推镜", "推进", "推近"] },
  { canonical: "拉远", aliases: ["拉远", "拉镜", "后退"] },
  { canonical: "横移", aliases: ["横移", "左右移动", "平移"] },
  { canonical: "跟拍", aliases: ["跟拍", "跟随"] },
  { canonical: "环绕", aliases: ["环绕", "绕"] },
  { canonical: "摇镜", aliases: ["摇镜", "摇移"] },
  { canonical: "升降镜头", aliases: ["升降", "上升", "下降"] },
  { canonical: "手持晃动", aliases: ["手持", "晃动"] },
  { canonical: "固定镜头", aliases: ["固定镜头", "固定"] },
];

const transitionRules: MatchRule[] = [
  { canonical: "动作衔接", aliases: ["动作衔接", "动作匹配", "动作接", "翻照片"] },
  { canonical: "匹配剪辑", aliases: ["匹配剪辑", "匹配", "match"] },
  { canonical: "硬切", aliases: ["硬切", "直接切", "切到下一镜头", "快切"] },
  { canonical: "淡入淡出", aliases: ["淡入淡出", "淡出", "淡入"] },
  { canonical: "叠化", aliases: ["叠化", "溶解", "dissolve"] },
  { canonical: "黑场转场", aliases: ["黑场", "黑屏"] },
  { canonical: "白闪转场", aliases: ["白闪", "闪白"] },
  { canonical: "遮挡转场", aliases: ["遮挡", "遮蔽"] },
  { canonical: "推拉转场", aliases: ["推拉转场", "推拉", "推进转场"] },
  { canonical: "光晕转场", aliases: ["光晕", "强光", "光斑"] },
];

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function uniqueById(items: KnowledgeItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function getWantedNames(text: string, rules: MatchRule[]) {
  const normalized = normalize(text);
  return rules
    .map((rule) => {
      const indexes = rule.aliases
        .map((alias) => normalized.indexOf(normalize(alias)))
        .filter((index) => index >= 0);
      return { canonical: rule.canonical, index: Math.min(...indexes) };
    })
    .filter((match) => Number.isFinite(match.index))
    .sort((a, b) => a.index - b.index)
    .map((rule) => rule.canonical);
}

function matchesName(item: KnowledgeItem, wanted: string) {
  const itemName = normalize(item.name);
  const wantedName = normalize(wanted);
  return itemName === wantedName || itemName.includes(wantedName);
}

function matchItems(items: KnowledgeItem[], type: KnowledgeItem["type"], wantedNames: string[]) {
  if (!wantedNames.length) return [];
  return uniqueById(
    wantedNames.flatMap((wanted) =>
      items.filter((item) => item.type === type && matchesName(item, wanted))
    )
  );
}

export function matchShotReferences(
  shot: Pick<StoryboardShot, "shotType" | "cameraMovement" | "transition">,
  items: KnowledgeItem[]
): ShotReferenceMatches {
  return {
    shot: matchItems(items, "shot", getWantedNames(shot.shotType, shotRules)),
    camera: matchItems(items, "camera_movement", getWantedNames(shot.cameraMovement, cameraRules)),
    transition: matchItems(items, "transition", getWantedNames(shot.transition, transitionRules)),
  };
}
