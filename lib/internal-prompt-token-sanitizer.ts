export type InternalPromptTokenHit = {
  token: string;
  replacement: string;
};

type InternalPromptTokenRule = {
  label: string;
  pattern: RegExp;
  replacement: string;
};

const INTERNAL_PROMPT_TOKEN_RULES: InternalPromptTokenRule[] = [
  {
    label: "single-segment AnalysisResult",
    pattern: /\bsingle[-_\s]*segment\s+AnalysisResult\b/gi,
    replacement: "单段视频提示词结果",
  },
  {
    label: "single-segment-analysis-result",
    pattern: /\bsingle[-_\s]*segment[-_\s]*analysis[-_\s]*result\b/gi,
    replacement: "单段视频提示词结果",
  },
  {
    label: "video_prompt_segment",
    pattern: /\bvideo[-_\s]*prompt[-_\s]*segment\b/gi,
    replacement: "视频段",
  },
  {
    label: "single-segment",
    pattern: /\bsingle[-_\s]*segment\b/gi,
    replacement: "单段",
  },
  {
    label: "chat-log",
    pattern: /\bchat[-_\s]*log\b/gi,
    replacement: "聊天记录证据",
  },
  {
    label: "digital-records",
    pattern: /\bdigital[-_\s]*records\b/gi,
    replacement: "数字证据",
  },
  {
    label: "forensic_room",
    pattern: /\bforensic[-_\s]*room\b/gi,
    replacement: "法医室",
  },
  {
    label: "case-room",
    pattern: /\bcase[-_\s]*room\b/gi,
    replacement: "专案会议室",
  },
  {
    label: "AnalysisResult",
    pattern: /\bAnalysisResult\b/g,
    replacement: "视频提示词结果",
  },
];

export function sanitizeInternalPromptTokens(value: string) {
  return INTERNAL_PROMPT_TOKEN_RULES.reduce(
    (current, rule) => current.replace(rule.pattern, rule.replacement),
    value,
  );
}

export function findInternalPromptToken(value: unknown): InternalPromptTokenHit | null {
  if (typeof value !== "string") return null;
  for (const rule of INTERNAL_PROMPT_TOKEN_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(value)) {
      return {
        token: rule.label,
        replacement: rule.replacement,
      };
    }
  }
  return null;
}

export function containsInternalPromptToken(value: unknown) {
  return Boolean(findInternalPromptToken(value));
}

export function sanitizeInternalPromptTokensDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeInternalPromptTokens(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeInternalPromptTokensDeep(item)) as T;
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sanitizeInternalPromptTokensDeep(item),
    ]),
  ) as T;
}
