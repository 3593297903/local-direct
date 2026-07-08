import type { AnalysisResult, StoryboardShot } from "../types";
import { findInternalPromptToken, sanitizeInternalPromptTokensDeep } from "./internal-prompt-token-sanitizer";

export type BatchSegmentQualitySeverity = "blocking" | "patchable" | "warning" | "risk";

export type BatchSegmentQualityFindingCode =
  | "missing_storyboard"
  | "missing_required_field"
  | "field_below_hard_minimum"
  | "field_below_target"
  | "full_prompt_too_short"
  | "internal_token"
  | "episode_terminology"
  | "vertical_conflict"
  | "placeholder_text"
  | "nullish_text"
  | "duplicate_visual"
  | "sensitive_term";

export type BatchSegmentQualityFinding = {
  severity: BatchSegmentQualitySeverity;
  code: BatchSegmentQualityFindingCode;
  message: string;
  path?: string;
  field?: string;
  shotNumber?: number;
  currentLength?: number;
  minimumLength?: number;
  targetLength?: number;
};

export type BatchSegmentQualityGate = {
  score: number;
  findings: BatchSegmentQualityFinding[];
  blockingFindings: BatchSegmentQualityFinding[];
  patchableFindings: BatchSegmentQualityFinding[];
  warningFindings: BatchSegmentQualityFinding[];
  riskFindings: BatchSegmentQualityFinding[];
};

export type BatchSegmentQualityOptions = {
  minFullPromptLength?: number;
  expectedShotCount?: number;
  fullPromptText?: string;
};

type FieldQualityRule = {
  hard: number;
  target: number;
  patchable: boolean;
};

export const BATCH_SEGMENT_FIELD_QUALITY_RULES: Record<string, FieldQualityRule> = {
  timeRange: { hard: 1, target: 1, patchable: true },
  scene: { hard: 4, target: 8, patchable: true },
  visual: { hard: 30, target: 36, patchable: true },
  shotType: { hard: 1, target: 2, patchable: true },
  composition: { hard: 18, target: 24, patchable: true },
  cameraMovement: { hard: 2, target: 2, patchable: false },
  lighting: { hard: 14, target: 20, patchable: true },
  sound: { hard: 8, target: 16, patchable: true },
  dialogue: { hard: 1, target: 1, patchable: true },
  emotion: { hard: 2, target: 4, patchable: true },
  transition: { hard: 1, target: 2, patchable: true },
  shotPurpose: { hard: 16, target: 20, patchable: true },
  firstFramePrompt: { hard: 18, target: 24, patchable: true },
  videoPrompt: { hard: 32, target: 40, patchable: true },
  lastFramePrompt: { hard: 18, target: 24, patchable: true },
  negativePrompt: { hard: 10, target: 16, patchable: true },
};

const REQUIRED_SHOT_FIELDS = Object.keys(BATCH_SEGMENT_FIELD_QUALITY_RULES) as Array<keyof StoryboardShot>;

const BASIC_NEGATIVE_PROMPT = "不要字幕水印，不要文字错误，不要畸形手指，不要低清画面，不要多余肢体";

const SENSITIVE_REWRITE_RULES: Array<[RegExp, string]> = [
  [/公安局/g, "办案建筑"],
  [/警徽/g, "机构标识"],
  [/国徽/g, "建筑正门标识"],
  [/血泊/g, "地面深色水痕"],
  [/伤口特写/g, "受伤痕迹的克制远景"],
  [/真实警服/g, "深色制服"],
  [/政治人物/g, "公共人物"],
];

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactLength(value: unknown) {
  return cleanText(value).replace(/\s+/g, "").length;
}

function pathForShotField(index: number, field: string) {
  return `storyboard[${index}].${field}`;
}

function pushFieldFinding(
  findings: BatchSegmentQualityFinding[],
  index: number,
  field: string,
  value: unknown,
  rule: FieldQualityRule,
) {
  const length = compactLength(value);
  if (length >= rule.target) return;
  if (length < rule.hard) {
    findings.push({
      severity: rule.patchable ? "patchable" : "blocking",
      code: "field_below_hard_minimum",
      message: `${field} 低于硬底线`,
      path: pathForShotField(index, field),
      field,
      shotNumber: index + 1,
      currentLength: length,
      minimumLength: rule.hard,
      targetLength: rule.target,
    });
    return;
  }
  findings.push({
    severity: rule.patchable ? "patchable" : "warning",
    code: "field_below_target",
    message: `${field} 低于目标长度，允许本地补强或作为警告通过`,
    path: pathForShotField(index, field),
    field,
    shotNumber: index + 1,
    currentLength: length,
    minimumLength: rule.hard,
    targetLength: rule.target,
  });
}

function containsPlaceholderText(value: string) {
  return /同上|如上|见上文|略|其他\s*[:：]\s*无|^\s*略\s*$/m.test(value);
}

function containsNullishText(value: string) {
  return /\bundefined\b|\bnull\b/i.test(value);
}

function containsEpisodeTerminology(value: string) {
  return /第\s*[0-9一二三四五六七八九十百]+\s*集|本集|单集|剧集/.test(value);
}

function containsVerticalConflict(value: string) {
  return /16\s*:\s*9\s*竖屏|竖屏\s*16\s*:\s*9|横屏\s*竖屏/.test(value);
}

function applyStringRules(value: string) {
  let next = value;
  for (const [pattern, replacement] of SENSITIVE_REWRITE_RULES) {
    next = next.replace(pattern, replacement);
  }
  return next
    .replace(/第\s*([0-9一二三四五六七八九十百]+)\s*集/g, "第 $1 段")
    .replace(/本集/g, "本段")
    .replace(/单集/g, "单段")
    .replace(/剧集/g, "分段")
    .replace(/16\s*:\s*9\s*竖屏|竖屏\s*16\s*:\s*9/g, "16:9横屏")
    .replace(/\bundefined\b|\bnull\b/gi, "空字段或占位文本");
}

function rewriteStringsDeep<T>(value: T): T {
  if (typeof value === "string") return applyStringRules(value) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteStringsDeep(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, rewriteStringsDeep(item)]),
  ) as T;
}

function shotContext(shot: Partial<StoryboardShot>) {
  return [
    cleanText(shot.scene),
    cleanText(shot.visual),
    cleanText(shot.composition),
    cleanText(shot.cameraMovement),
    cleanText(shot.lighting),
    cleanText(shot.sound),
    cleanText(shot.emotion),
  ].filter(Boolean).join("，");
}

function ensureTargetLength(value: unknown, target: number, fallback: string) {
  const text = cleanText(value);
  if (compactLength(text) >= target) return text;
  const merged = [text, fallback].filter(Boolean).join("，");
  return compactLength(merged) >= target ? merged : `${merged}，画面保持电影短剧质感，动作和环境信息清晰可执行`;
}

function normalizeNegativePrompt(value: unknown) {
  const text = cleanText(value);
  if (!text) return BASIC_NEGATIVE_PROMPT;
  const additions = BASIC_NEGATIVE_PROMPT
    .split("，")
    .filter((item) => item && !text.includes(item));
  return additions.length ? `${text}，${additions.join("，")}` : text;
}

function patchShot(shot: StoryboardShot, index: number): StoryboardShot {
  const context = shotContext(shot);
  const sceneFallback = [cleanText(shot.shotType), cleanText(shot.visual)].filter(Boolean).join("，") || "当前段核心场景";
  const visualFallback = [cleanText(shot.scene), cleanText(shot.composition), cleanText(shot.cameraMovement)].filter(Boolean).join("，");
  const movementFallback = [cleanText(shot.visual), cleanText(shot.cameraMovement), cleanText(shot.lighting), cleanText(shot.sound)].filter(Boolean).join("，");

  return {
    ...shot,
    shotNumber: Number.isFinite(Number(shot.shotNumber)) ? Number(shot.shotNumber) : index + 1,
    timeRange: cleanText(shot.timeRange) || `${index * 3}s-${(index + 1) * 3}s`,
    scene: ensureTargetLength(shot.scene, BATCH_SEGMENT_FIELD_QUALITY_RULES.scene.target, sceneFallback),
    visual: ensureTargetLength(shot.visual, BATCH_SEGMENT_FIELD_QUALITY_RULES.visual.target, visualFallback || context),
    shotType: cleanText(shot.shotType) || "中景",
    composition: ensureTargetLength(shot.composition, BATCH_SEGMENT_FIELD_QUALITY_RULES.composition.target, context),
    cameraMovement: cleanText(shot.cameraMovement) || "轻微推进",
    lighting: ensureTargetLength(shot.lighting, BATCH_SEGMENT_FIELD_QUALITY_RULES.lighting.target, context),
    sound: ensureTargetLength(shot.sound, BATCH_SEGMENT_FIELD_QUALITY_RULES.sound.target, context || "保留真实环境声"),
    dialogue: cleanText(shot.dialogue) || "无",
    emotion: ensureTargetLength(shot.emotion, BATCH_SEGMENT_FIELD_QUALITY_RULES.emotion.target, cleanText(shot.visual) || "克制"),
    transition: cleanText(shot.transition) || "自然转场",
    shotPurpose: ensureTargetLength(shot.shotPurpose, BATCH_SEGMENT_FIELD_QUALITY_RULES.shotPurpose.target, context),
    firstFramePrompt: ensureTargetLength(
      shot.firstFramePrompt,
      BATCH_SEGMENT_FIELD_QUALITY_RULES.firstFramePrompt.target,
      [cleanText(shot.scene), cleanText(shot.visual), "首帧定格关键人物与空间关系"].filter(Boolean).join("，"),
    ),
    videoPrompt: ensureTargetLength(shot.videoPrompt, BATCH_SEGMENT_FIELD_QUALITY_RULES.videoPrompt.target, movementFallback || context),
    lastFramePrompt: ensureTargetLength(
      shot.lastFramePrompt,
      BATCH_SEGMENT_FIELD_QUALITY_RULES.lastFramePrompt.target,
      [cleanText(shot.visual), cleanText(shot.emotion), "尾帧保留段尾情绪和下一动作悬念"].filter(Boolean).join("，"),
    ),
    negativePrompt: normalizeNegativePrompt(shot.negativePrompt),
  };
}

function visualFingerprint(value: unknown) {
  return cleanText(value).replace(/\s+/g, "").replace(/[，。；：、“”‘’（）【】\-—]/g, "").toLowerCase();
}

export function evaluateBatchSegmentQuality(
  result: AnalysisResult,
  options: BatchSegmentQualityOptions = {},
): BatchSegmentQualityGate {
  const findings: BatchSegmentQualityFinding[] = [];
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  const fullPromptText = options.fullPromptText || cleanText(result.workflow?.fullVideoPrompt);
  const serialized = JSON.stringify(result);

  if (!storyboard.length) {
    findings.push({ severity: "blocking", code: "missing_storyboard", message: "缺少 storyboard 镜头列表" });
  }

  const internalHit = findInternalPromptToken(serialized) || findInternalPromptToken(fullPromptText);
  if (internalHit) {
    findings.push({
      severity: "blocking",
      code: "internal_token",
      message: `包含内部系统标识 ${internalHit.token}`,
    });
  }

  for (const [value, path] of [[serialized, "result"], [fullPromptText, "workflow.fullVideoPrompt"]] as const) {
    if (containsNullishText(value)) findings.push({ severity: "patchable", code: "nullish_text", message: "包含 undefined/null 字面占位", path });
    if (containsEpisodeTerminology(value)) findings.push({ severity: "patchable", code: "episode_terminology", message: "包含集/本集/单集术语", path });
    if (containsVerticalConflict(value)) findings.push({ severity: "patchable", code: "vertical_conflict", message: "包含 16:9 竖屏冲突", path });
    if (containsPlaceholderText(value)) findings.push({ severity: "blocking", code: "placeholder_text", message: "包含同上/如上/略等不可执行占位", path });
    for (const [pattern] of SENSITIVE_REWRITE_RULES) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        findings.push({ severity: "risk", code: "sensitive_term", message: "包含可本地规避的 Seedance 风险表达", path });
        break;
      }
    }
  }

  if (options.expectedShotCount && storyboard.length && storyboard.length !== options.expectedShotCount) {
    findings.push({
      severity: "blocking",
      code: "missing_storyboard",
      message: `镜头数 ${storyboard.length} 与规划 ${options.expectedShotCount} 不一致`,
    });
  }

  const seenVisuals = new Map<string, number>();
  storyboard.forEach((shot, index) => {
    for (const field of REQUIRED_SHOT_FIELDS) {
      const value = shot[field];
      const rule = BATCH_SEGMENT_FIELD_QUALITY_RULES[field];
      if (typeof value !== "string" || !value.trim()) {
        const patchable = field === "dialogue" || field === "negativePrompt" || field === "timeRange";
        findings.push({
          severity: patchable ? "patchable" : "blocking",
          code: "missing_required_field",
          message: `${field} 缺失`,
          path: pathForShotField(index, field),
          field,
          shotNumber: index + 1,
        });
        continue;
      }
      pushFieldFinding(findings, index, field, value, rule);
    }

    const visual = visualFingerprint(shot.visual || shot.videoPrompt);
    if (visual.length >= 24) {
      const previous = seenVisuals.get(visual);
      if (previous !== undefined) {
        findings.push({
          severity: "blocking",
          code: "duplicate_visual",
          message: `镜头 ${previous + 1} 和镜头 ${index + 1} 画面重复`,
          path: pathForShotField(index, "visual"),
          shotNumber: index + 1,
        });
      } else {
        seenVisuals.set(visual, index);
      }
    }
  });

  const minFullPromptLength = options.minFullPromptLength || 900;
  const fullPromptLength = compactLength(fullPromptText);
  if (fullPromptLength > 0 && fullPromptLength < minFullPromptLength) {
    const storyboardSignal = storyboard.reduce((sum, shot) => (
      sum + compactLength(shot.visual) + compactLength(shot.videoPrompt) + compactLength(shot.firstFramePrompt) + compactLength(shot.lastFramePrompt)
    ), 0);
    findings.push({
      severity: storyboardSignal >= minFullPromptLength ? "patchable" : "blocking",
      code: "full_prompt_too_short",
      message: `完整提示词低于 ${minFullPromptLength} 字`,
      path: "workflow.fullVideoPrompt",
      currentLength: fullPromptLength,
      minimumLength: minFullPromptLength,
    });
  }

  const blockingFindings = findings.filter((finding) => finding.severity === "blocking");
  const patchableFindings = findings.filter((finding) => finding.severity === "patchable");
  const warningFindings = findings.filter((finding) => finding.severity === "warning");
  const riskFindings = findings.filter((finding) => finding.severity === "risk");
  const score = Math.max(
    0,
    100
      - blockingFindings.length * 30
      - patchableFindings.length * 8
      - warningFindings.length * 3
      - riskFindings.length * 5,
  );

  return { score, findings, blockingFindings, patchableFindings, warningFindings, riskFindings };
}

export function applyDeterministicQualityPatch<T extends AnalysisResult>(
  result: T,
  _findings: BatchSegmentQualityFinding[] = [],
): T {
  const sanitized = rewriteStringsDeep(sanitizeInternalPromptTokensDeep(result)) as T;
  const storyboard = Array.isArray(sanitized.storyboard)
    ? sanitized.storyboard.map((shot, index) => patchShot(shot, index))
    : [];
  const workflow = sanitized.workflow
    ? rewriteStringsDeep({
        ...sanitized.workflow,
        fullNegativePrompt: normalizeNegativePrompt(sanitized.workflow.fullNegativePrompt),
      })
    : sanitized.workflow;
  return {
    ...sanitized,
    workflow,
    storyboard,
  };
}

export function shouldRepairWithCodex(gate: BatchSegmentQualityGate) {
  return gate.blockingFindings.length > 0;
}

export function summarizeQualityFindings(findings: BatchSegmentQualityFinding[]) {
  return findings
    .map((finding) => {
      const location = finding.path ? `${finding.path}: ` : "";
      const length = finding.currentLength !== undefined && finding.minimumLength !== undefined
        ? ` (${finding.currentLength}/${finding.minimumLength})`
        : "";
      return `${location}${finding.message}${length}`;
    })
    .join("；");
}

export function buildTargetedRepairReason(gate: BatchSegmentQualityGate) {
  const blocking = gate.blockingFindings.length ? gate.blockingFindings : gate.findings;
  return summarizeQualityFindings(blocking) || "当前段未通过质量门";
}
