export const GENRE_OPTIONS = [
  "剧情",
  "动作",
  "冒险",
  "战斗",
  "喜剧",
  "爱情",
  "悬疑",
  "惊悚",
  "恐怖",
  "犯罪",
  "警匪",
  "科幻",
  "奇幻",
  "古风",
  "日常",
  "灾难",
  "战争",
  "历史",
] as const;

export type GenreOption = (typeof GENRE_OPTIONS)[number];
