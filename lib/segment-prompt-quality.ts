export type SegmentPromptQualitySeverity = "blocking" | "suggestion";

export type SegmentPromptQualityIssue = {
  code: string;
  severity: SegmentPromptQualitySeverity;
  label: string;
  detail: string;
  field?: string;
  shotNumber?: number;
};

export type SegmentPromptQualityInput = {
  segmentNumber?: number;
  title?: string | null;
  duration?: string | null;
  fullVideoPrompt?: string | null;
  optimizedScript?: string | null;
  shots?: Array<Record<string, unknown>>;
  minPromptLength?: number;
};

export type SegmentPromptQualitySummary = {
  blockingCount: number;
  suggestionCount: number;
  totalCount: number;
};

export const EPISODE_TERMINOLOGY_PATTERN = /(?:\u7b2c\s*[0-9\u4e00-\u9fa5]+\s*\u96c6|\u672c\u96c6|\u5355\u96c6|\u5267\u96c6)/;
export const PLACEHOLDER_PATTERN = /(?:\u540c\u4e0a|\u5982\u4e0a|\u89c1\u4e0a|\u7565|continue as above)/i;
export const VERTICAL_CONFLICT_PATTERN = /(?:16\s*:\s*9\s*\u7ad6\u5c4f|\u7ad6\u5c4f\s*16\s*:\s*9|\u6a2a\u5c4f\s*\u7ad6\u5c4f)/;
const EMPTY_FIELD_PATTERN = /(?:undefined|null)/i;
const QUESTION_DAMAGE_PATTERN = /\?{8,}/;
const DEFAULT_MIN_PROMPT_LENGTH = 1200;
const REQUIRED_SHOT_FIELDS = [
  "visual",
  "shotType",
  "composition",
  "cameraMovement",
  "lighting",
  "sound",
  "dialogue",
  "emotion",
  "transition",
  "shotPurpose",
  "firstFramePrompt",
  "videoPrompt",
  "lastFramePrompt",
  "negativePrompt",
] as const;

export function analyzeSegmentPromptQuality(input: SegmentPromptQualityInput) {
  const issues: SegmentPromptQualityIssue[] = [];
  const promptText = normalizeText(input.fullVideoPrompt);
  const optimizedScript = normalizeText(input.optimizedScript);
  const combinedText = [input.title, input.duration, promptText, optimizedScript].map(normalizeText).join("\n");
  const minPromptLength = input.minPromptLength ?? DEFAULT_MIN_PROMPT_LENGTH;

  if (!promptText) {
    issues.push(createIssue("missing_prompt", "blocking", "缺少完整提示词", "本段没有可审阅的 fullVideoPrompt。"));
  } else if (promptText.length < minPromptLength) {
    issues.push(
      createIssue(
        "short_prompt",
        "suggestion",
        "提示词偏短",
        `完整提示词约 ${promptText.length} 字，建议补足镜头画面、光影、声音和镜头目的。`,
      ),
    );
  }

  if (EMPTY_FIELD_PATTERN.test(combinedText)) {
    issues.push(createIssue("empty_field_literal", "blocking", "存在空字段文本", "提示词里出现 undefined 或 null。"));
  }

  if (EPISODE_TERMINOLOGY_PATTERN.test(combinedText)) {
    issues.push(createIssue("episode_terminology", "blocking", "存在集数术语", "用户侧应统一使用“段”，不要出现“集/本集/单集”。"));
  }

  if (VERTICAL_CONFLICT_PATTERN.test(combinedText)) {
    issues.push(createIssue("vertical_conflict", "blocking", "画幅描述冲突", "提示词同时出现 16:9 和竖屏等冲突表达。"));
  }

  if (PLACEHOLDER_PATTERN.test(combinedText)) {
    issues.push(createIssue("placeholder_text", "blocking", "存在占位表达", "提示词里出现同上、如上、略等不可执行表达。"));
  }

  if (QUESTION_DAMAGE_PATTERN.test(combinedText)) {
    issues.push(createIssue("encoding_damage", "blocking", "疑似中文编码损坏", "提示词里出现连续问号，可能是中文被写坏。"));
  }

  const shots = Array.isArray(input.shots) ? input.shots : [];
  const seenVisuals = new Map<string, number>();
  for (const shot of shots) {
    const shotNumber = getShotNumber(shot);
    for (const field of REQUIRED_SHOT_FIELDS) {
      const value = normalizeText(shot[field]);
      if (!value) {
        issues.push(
          createIssue(
            "missing_shot_field",
            "blocking",
            "镜头字段缺失",
            `镜头 ${shotNumber} 缺少 ${field}。`,
            field,
            shotNumber,
          ),
        );
      } else if (PLACEHOLDER_PATTERN.test(value)) {
        issues.push(
          createIssue(
            "placeholder_shot_field",
            "blocking",
            "镜头字段不可执行",
            `镜头 ${shotNumber} 的 ${field} 使用了占位表达。`,
            field,
            shotNumber,
          ),
        );
      }
    }

    const visualKey = normalizeForDuplicate(shot.visual);
    if (visualKey) {
      const previousShot = seenVisuals.get(visualKey);
      if (previousShot) {
        issues.push(
          createIssue(
            "duplicate_shot_visual",
            "suggestion",
            "镜头画面重复",
            `镜头 ${previousShot} 和镜头 ${shotNumber} 的画面描述高度重复。`,
            "visual",
            shotNumber,
          ),
        );
      } else {
        seenVisuals.set(visualKey, shotNumber);
      }
    }
  }

  return issues;
}

export function summarizeSegmentPromptQuality(issues: SegmentPromptQualityIssue[]): SegmentPromptQualitySummary {
  const blockingCount = issues.filter((issue) => issue.severity === "blocking").length;
  const suggestionCount = issues.filter((issue) => issue.severity === "suggestion").length;
  return {
    blockingCount,
    suggestionCount,
    totalCount: issues.length,
  };
}

function createIssue(
  code: string,
  severity: SegmentPromptQualitySeverity,
  label: string,
  detail: string,
  field?: string,
  shotNumber?: number,
): SegmentPromptQualityIssue {
  return { code, severity, label, detail, field, shotNumber };
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function getShotNumber(shot: Record<string, unknown>) {
  const numberValue = Number(shot.shotNumber);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function normalizeForDuplicate(value: unknown) {
  const text = normalizeText(value)
    .replace(/\s+/g, "")
    .replace(/[，。,.、；;：:！!？?]/g, "");
  return text.length >= 16 ? text.slice(0, 80) : "";
}
