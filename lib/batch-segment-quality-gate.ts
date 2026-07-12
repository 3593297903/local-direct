import type { AnalysisResult, StoryboardShot } from "../types";
import type { SegmentContract } from "./batch-segment-contract";
import type { CoverageDecision } from "./batch-event-coverage";
import {
  findInternalPromptToken,
  sanitizeInternalPromptTokens,
  sanitizeInternalPromptTokensDeep,
} from "./internal-prompt-token-sanitizer";
import {
  analyzePromptSafetyTree,
  applyPromptSafetyPolicy,
  type PromptSafetyPathClass,
  type PromptSafetyPolarity,
  type PromptSafetyRisk,
} from "./prompt-safety-policy";

export type BatchSegmentQualitySeverity = "blocking" | "patchable" | "warning" | "risk";

export type BatchSegmentQualityFindingCode =
  | "missing_storyboard"
  | "missing_required_field"
  | "field_below_hard_minimum"
  | "field_below_target"
  | "full_prompt_too_short"
  | "empty_full_prompt"
  | "internal_token"
  | "episode_terminology"
  | "vertical_conflict"
  | "placeholder_text"
  | "nullish_text"
  | "duplicate_visual"
  | "sensitive_term"
  | "shot_count_mismatch"
  | "too_many_shots"
  | "too_few_shots"
  | "duration_exceeds_contract"
  | "forbidden_future_event"
  | "missing_required_event_slot"
  | "ambiguous_required_event_slot"
  | "continuity_contradiction"
  | "weak_contract"
  | "weak_required_event_slot"
  | "template_summary"
  | "source_shot_count_mismatch";

export type BatchSegmentQualityFinding = {
  severity: BatchSegmentQualitySeverity;
  code: BatchSegmentQualityFindingCode;
  message: string;
  path?: string;
  field?: string;
  shotNumber?: number;
  slotId?: string;
  currentValue?: unknown;
  currentLength?: number;
  minimumLength?: number;
  targetLength?: number;
  fingerprint?: string;
  ruleId?: string;
  pathClass?: PromptSafetyPathClass;
  polarity?: PromptSafetyPolarity;
  affectedPaths?: string[];
  affectedPathCount?: number;
};

export type QualityPatchDiff = {
  path: string;
  code: BatchSegmentQualityFindingCode;
  severity: Extract<BatchSegmentQualitySeverity, "patchable" | "risk">;
  before: unknown;
  after: unknown;
  patchSource: "local" | "codex";
  reason: string;
};

export type DeterministicQualityPatchResult<T extends AnalysisResult> = {
  result: T;
  patchDiffs: QualityPatchDiff[];
};

export type BatchSegmentQualityGate = {
  score: number;
  promptQualityScore: number;
  complianceRisk: PromptSafetyRisk;
  findings: BatchSegmentQualityFinding[];
  blockingFindings: BatchSegmentQualityFinding[];
  patchableFindings: BatchSegmentQualityFinding[];
  warningFindings: BatchSegmentQualityFinding[];
  riskFindings: BatchSegmentQualityFinding[];
};

export type BatchSegmentQualityOptions = {
  segmentIndex?: number;
  minFullPromptLength?: number;
  expectedShotCount?: number;
  sourceShotCount?: number;
  minShotCount?: number;
  maxShotCount?: number;
  requestedDuration?: string;
  contract?: SegmentContract;
  coverageDecisions?: CoverageDecision[];
  coverageMode?: "shadow" | "active";
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

const PLACEHOLDER_TEXT_PATTERN = /同上|如上|见上文|其他\s*[:：]\s*无|其它\s*[:：]\s*无|(?:^|[，。；、\s])略(?:[，。；、\s]|$)/m;

const SENSITIVE_REWRITE_RULES: Array<[RegExp, string]> = [
  [/公安局/g, "办案建筑"],
  [/警徽/g, "机构标识"],
  [/国徽/g, "建筑正门标识"],
  [/血泊/g, "地面深色水痕"],
  [/伤口特写/g, "受伤痕迹的克制远景"],
  [/真实警服/g, "深色制服"],
  [/政治人物/g, "公共人物"],
];

const GENERIC_BATCH_TEMPLATE_PHRASES = [
  "人物、地点和关键物件按案件逻辑分层",
  "缓慢推进后停住",
  "同期环境声、脚步声、纸张声或市场声",
  "保留北方县城真实空间感",
];

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactLength(value: unknown) {
  return cleanText(value).replace(/\s+/g, "").length;
}

function parseDurationSeconds(value: unknown) {
  const text = cleanText(value);
  if (!text || /^auto$/i.test(text)) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|seconds?)/i) || text.match(/^(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : 0;
}

function normalizeContractText(value: unknown) {
  return cleanText(value)
    .replace(/\s+/g, "")
    .replace(/[，。；：、""''《》【】（）()|\-—–]/g, "")
    .toLowerCase();
}

function pathForShotField(index: number, field: string) {
  return `storyboard[${index}].${field}`;
}

function parseQualityPath(path: string) {
  const parts: Array<string | number> = [];
  const pattern = /([^[.\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path))) {
    if (match[1]) parts.push(match[1]);
    if (match[2]) parts.push(Number(match[2]));
  }
  return parts;
}

function getValueAtPath(value: unknown, path: string) {
  if (!path) return value;
  let current = value as any;
  for (const part of parseQualityPath(path)) {
    if (current == null) return undefined;
    current = current[part as any];
  }
  return current;
}

function setValueAtPath<T>(value: T, path: string, nextValue: unknown): T {
  const parts = parseQualityPath(path);
  if (!parts.length) return value;
  const cloneRoot: any = Array.isArray(value) ? [...value as any[]] : { ...(value as any) };
  let current = cloneRoot;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] as any;
    const child = current[part];
    current[part] = Array.isArray(child) ? [...child] : { ...(child || {}) };
    current = current[part];
  }
  current[parts[parts.length - 1] as any] = nextValue;
  return cloneRoot;
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
      currentValue: value,
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
    currentValue: value,
    currentLength: length,
    minimumLength: rule.hard,
    targetLength: rule.target,
  });
}

function containsPlaceholderText(value: string) {
  PLACEHOLDER_TEXT_PATTERN.lastIndex = 0;
  return PLACEHOLDER_TEXT_PATTERN.test(value);
}

function isNegativePromptPath(path: string) {
  return /(^|\.)(fullNegativePrompt|negativePrompt)$/.test(path);
}

function isPatchablePlaceholderPath(path: string) {
  return isNegativePromptPath(path) || path === "workflow.fullVideoPrompt" || path === "result.workflow.fullVideoPrompt";
}

function rewritePlaceholderWarningLanguage(value: string) {
  return value
    .replace(/同上[、，/和\s]*如上[、，/和\s]*略等?(?:不可执行)?占位(?:内容|表达|文本)?/g, "不可执行占位表达、空泛描述、跨段引用")
    .replace(/同上[、，/和\s]*如上[、，/和\s]*略/g, "跨段引用、省略描述")
    .replace(/(?:同上|如上|见上文)等?(?:不可执行)?占位(?:内容|表达|文本)?/g, "跨段引用类占位表达");
}

function rewriteNegativePromptPlaceholderLanguage(value: string) {
  return rewritePlaceholderWarningLanguage(value)
    .replace(/同上|如上|见上文/g, "跨段引用")
    .replace(/(^|[，。；、\s])略(?=([，。；、\s]|$))/g, "$1省略描述");
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

function qualityFieldFromPath(path: string) {
  const match = path.match(/(?:^|\.)([^.[\]]+)$/);
  return match ? match[1] : undefined;
}

function applyStringRules(value: string, path = "") {
  let next = rewritePlaceholderWarningLanguage(value);
  next = applyPromptSafetyPolicy(next, { phase: "quality", path, field: qualityFieldFromPath(path) }).text;
  return next
    .replace(/第\s*([0-9一二三四五六七八九十百]+)\s*集/g, "第 $1 段")
    .replace(/本集/g, "本段")
    .replace(/单集/g, "单段")
    .replace(/剧集/g, "分段")
    .replace(/16\s*:\s*9\s*竖屏|竖屏\s*16\s*:\s*9/g, "16:9横屏")
    .replace(/\bundefined\b|\bnull\b/gi, "空字段或占位文本");
}

function rewriteStringsDeep<T>(value: T, path = ""): T {
  if (typeof value === "string") return applyStringRules(value, path) as T;
  if (Array.isArray(value)) return value.map((item, index) => rewriteStringsDeep(item, `${path}[${index}]`)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      rewriteStringsDeep(item, path ? `${path}.${key}` : key),
    ]),
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

function normalizeNegativePrompt(value: unknown, path = "negativePrompt") {
  const text = rewriteNegativePromptPlaceholderLanguage(applyStringRules(cleanText(value), path));
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

function collectPlaceholderFindings(
  value: unknown,
  path: string,
  findings: BatchSegmentQualityFinding[],
) {
  if (typeof value === "string") {
    if (!containsPlaceholderText(value)) return;
    findings.push({
      severity: isPatchablePlaceholderPath(path) ? "patchable" : "blocking",
      code: "placeholder_text",
      message: isPatchablePlaceholderPath(path)
        ? "负向提示词包含占位词禁止说明，允许本地改写"
        : "包含同上/如上/略等不可执行占位",
      path,
      currentValue: value,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPlaceholderFindings(item, `${path}[${index}]`, findings));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    collectPlaceholderFindings(item, path ? `${path}.${key}` : key, findings);
  });
}

function collectStringQualityFindings(
  value: unknown,
  path: string,
  findings: BatchSegmentQualityFinding[],
) {
  if (typeof value === "string") {
    const internalHit = findInternalPromptToken(value);
    if (internalHit) {
      findings.push({
        severity: "patchable",
        code: "internal_token",
        message: `鍖呭惈鍐呴儴绯荤粺鏍囪瘑 ${internalHit.token}`,
        path,
        currentValue: value,
      });
    }
    if (containsNullishText(value)) {
      findings.push({
        severity: "patchable",
        code: "nullish_text",
        message: "鍖呭惈 undefined/null 瀛楅潰鍗犱綅",
        path,
        currentValue: value,
      });
    }
    if (containsEpisodeTerminology(value)) {
      findings.push({
        severity: "patchable",
        code: "episode_terminology",
        message: "contains episode terminology",
        path,
        currentValue: value,
      });
    }
    if (containsVerticalConflict(value)) {
      findings.push({
        severity: "patchable",
        code: "vertical_conflict",
        message: "鍖呭惈 16:9 绔栧睆鍐茬獊",
        path,
        currentValue: value,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringQualityFindings(item, `${path}[${index}]`, findings));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    collectStringQualityFindings(item, path ? `${path}.${key}` : key, findings);
  });
}

export function evaluateBatchSegmentQuality(
  result: AnalysisResult,
  options: BatchSegmentQualityOptions = {},
): BatchSegmentQualityGate {
  const findings: BatchSegmentQualityFinding[] = [];
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  const fullPromptText = options.fullPromptText !== undefined
    ? cleanText(options.fullPromptText)
    : cleanText(result.workflow?.fullVideoPrompt);
  const serialized = JSON.stringify(result);
  const safetyAnalysis = analyzePromptSafetyTree(result, {
    phase: "quality",
    segmentIndex: options.segmentIndex || options.contract?.segmentIndex || 0,
    rootPath: "result",
  });

  if (!storyboard.length) {
    findings.push({ severity: "blocking", code: "missing_storyboard", message: "缺少 storyboard 镜头列表" });
  }

  const internalHit = null as ReturnType<typeof findInternalPromptToken>;
  if (internalHit) {
    findings.push({
      severity: "blocking",
      code: "internal_token",
      message: `包含内部系统标识 ${internalHit.token}`,
    });
  }

  for (const [value, path] of [] as Array<[string, string]>) {
    if (containsNullishText(value)) findings.push({ severity: "patchable", code: "nullish_text", message: "包含 undefined/null 字面占位", path });
    if (containsEpisodeTerminology(value)) findings.push({ severity: "patchable", code: "episode_terminology", message: "包含集/本集/单集术语", path });
    if (containsVerticalConflict(value)) findings.push({ severity: "patchable", code: "vertical_conflict", message: "包含 16:9 竖屏冲突", path });
    for (const [pattern] of SENSITIVE_REWRITE_RULES) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        findings.push({ severity: "risk", code: "sensitive_term", message: "包含可本地规避的 Seedance 风险表达", path });
        break;
      }
    }
  }

  collectStringQualityFindings(result, "result", findings);
  if (fullPromptText) collectStringQualityFindings(fullPromptText, "workflow.fullVideoPrompt", findings);
  collectPlaceholderFindings(result, "result", findings);
  for (const safetyFinding of safetyAnalysis.findings) {
    findings.push({
      severity: safetyFinding.severity,
      code: "sensitive_term",
      message: safetyFinding.reason,
      path: safetyFinding.primaryPath,
      currentValue: safetyFinding.match,
      fingerprint: safetyFinding.fingerprint,
      ruleId: safetyFinding.ruleId,
      pathClass: safetyFinding.pathClass,
      polarity: safetyFinding.polarity,
      affectedPaths: safetyFinding.affectedPaths,
      affectedPathCount: safetyFinding.affectedPathCount,
    });
  }

  if (!options.contract && options.expectedShotCount && storyboard.length && storyboard.length !== options.expectedShotCount) {
    findings.push({
      severity: "blocking",
      code: "shot_count_mismatch",
      message: `镜头数 ${storyboard.length} 与规划 ${options.expectedShotCount} 不一致`,
      currentLength: storyboard.length,
      minimumLength: options.expectedShotCount,
    });
  }

  if (options.contract && storyboard.length && storyboard.length !== options.contract.shotCount) {
    findings.push({
      severity: "blocking",
      code: "shot_count_mismatch",
      message: `镜头数 ${storyboard.length} 与段落规划要求的 ${options.contract.shotCount} 个镜头不一致`,
      currentLength: storyboard.length,
      minimumLength: options.contract.shotCount,
    });
  }

  const resultDurationSeconds = parseDurationSeconds(result.duration);
  if (
    options.contract
    && resultDurationSeconds > 0
    && resultDurationSeconds > options.contract.durationSeconds + 0.2
  ) {
    findings.push({
      severity: "blocking",
      code: "duration_exceeds_contract",
      message: `时长 ${resultDurationSeconds}s 超过段落规划上限 ${options.contract.durationSeconds}s`,
      currentLength: resultDurationSeconds,
      minimumLength: options.contract.durationSeconds,
    });
  }

  if (
    options.sourceShotCount
    && storyboard.length
    && (!options.maxShotCount || options.sourceShotCount <= options.maxShotCount)
    && storyboard.length !== options.sourceShotCount
  ) {
    findings.push({
      severity: "blocking",
      code: "source_shot_count_mismatch",
      message: `源文案有 ${options.sourceShotCount} 个镜头，结果为 ${storyboard.length} 个`,
      currentLength: storyboard.length,
      minimumLength: options.sourceShotCount,
    });
  }

  if (options.maxShotCount && storyboard.length > options.maxShotCount) {
    findings.push({
      severity: "blocking",
      code: "too_many_shots",
      message: `镜头数 ${storyboard.length} 超过上限 ${options.maxShotCount}`,
      currentLength: storyboard.length,
      minimumLength: options.maxShotCount,
    });
  }

  if (options.minShotCount && storyboard.length > 0 && storyboard.length < options.minShotCount) {
    findings.push({
      severity: "blocking",
      code: "too_few_shots",
      message: `镜头数 ${storyboard.length} 低于下限 ${options.minShotCount}`,
      currentLength: storyboard.length,
      minimumLength: options.minShotCount,
    });
  }

  if (options.contract) {
    const normalizedFullPrompt = normalizeContractText(fullPromptText);
    for (const slot of options.contract.requiredEventSlots || []) {
      if (!slot.anchorGroups?.length || !slot.conceptGroups?.length || slot.importance !== "blocking") {
        findings.push({
          severity: "warning",
          code: "weak_required_event_slot",
          message: `本段事件要求仅作为建议约束：${slot.label || slot.id}`,
        });
      }
    }
    for (const forbidden of options.contract.forbiddenFutureEvents || []) {
      const normalizedForbidden = normalizeContractText(forbidden);
      if (normalizedForbidden.length >= 4 && normalizedFullPrompt.includes(normalizedForbidden)) {
        findings.push({
          severity: "blocking",
          code: "forbidden_future_event",
          message: `提前泄露后续事件：${forbidden}`,
        });
      }
    }

    if (!options.coverageDecisions) {
      if ((options.contract.requiredEvents || []).length && !(options.contract.requiredEventSlots || []).length) {
        findings.push({
          severity: "warning",
          code: "weak_contract",
          message: "段落规划只有自然语言事件要求，不能据此触发自动修复",
        });
      }
    } else {
      for (const decision of options.coverageDecisions) {
        if (decision.status === "covered") continue;
        const path = decision.repairPaths[0];
        if (decision.status === "contradiction") {
          const activeBlocking = decision.importance === "blocking" && options.coverageMode === "active" && Boolean(path);
          findings.push({
            severity: activeBlocking ? "blocking" : "warning",
            code: decision.slotId.startsWith("continuity:") ? "continuity_contradiction" : "missing_required_event_slot",
            message: `检测到明确事件或连续性冲突：${decision.label}`,
            path,
            slotId: decision.slotId,
            currentValue: decision.evidenceQuotes.join("；"),
          });
          continue;
        }
        if (decision.status === "definite_missing") {
          const activeBlocking = decision.importance === "blocking" && options.coverageMode === "active" && Boolean(path);
          findings.push({
            severity: activeBlocking ? "blocking" : "warning",
            code: "missing_required_event_slot",
            message: `确定缺少本段必要事件：${decision.label}`,
            path,
            slotId: decision.slotId,
          });
          continue;
        }
        const activeBlocking = decision.importance === "blocking" && options.coverageMode === "active";
        findings.push({
          severity: activeBlocking ? "blocking" : "warning",
          code: "ambiguous_required_event_slot",
          message: `必要事件覆盖存在歧义，不能仅凭字面缺失判定：${decision.label}`,
          path: activeBlocking ? path : undefined,
          slotId: decision.slotId,
          currentValue: decision.evidenceQuotes.join("；"),
        });
      }
    }
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
  if (fullPromptLength === 0) {
    findings.push({
      severity: "blocking",
      code: "empty_full_prompt",
      message: "完整视频提示词为空",
      path: "workflow.fullVideoPrompt",
    });
  }
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

  const templateHits = GENERIC_BATCH_TEMPLATE_PHRASES.reduce(
    (count, phrase) => count + fullPromptText.split(phrase).length - 1,
    0,
  );
  if (templateHits >= 2) {
    findings.push({
      severity: "blocking",
      code: "template_summary",
      message: "提示词仍是模板化概要，没有生成具体镜头",
      path: "workflow.fullVideoPrompt",
    });
  }

  const blockingFindings = findings.filter((finding) => finding.severity === "blocking");
  const patchableFindings = findings.filter((finding) => finding.severity === "patchable");
  const warningFindings = findings.filter((finding) => finding.severity === "warning");
  const riskFindings = findings.filter((finding) => finding.severity === "risk");
  const promptQualityScore = Math.max(
    0,
    100
      - blockingFindings.length * 30
      - patchableFindings.length * 8
      - warningFindings.length * 3,
  );

  return {
    score: promptQualityScore,
    promptQualityScore,
    complianceRisk: safetyAnalysis.highestRisk,
    findings,
    blockingFindings,
    patchableFindings,
    warningFindings,
    riskFindings,
  };
}

function normalizePatchPath(path: string | undefined) {
  if (!path) return "";
  if (path === "result") return "";
  return path.startsWith("result.") ? path.slice("result.".length) : path;
}

function isPatchEligibleFinding(finding: BatchSegmentQualityFinding) {
  return finding.severity === "patchable" || finding.severity === "risk";
}

function shotIndexFromPath(path: string) {
  const match = path.match(/^storyboard\[(\d+)\]\.([A-Za-z0-9_]+)$/);
  if (!match) return null;
  return { index: Number(match[1]), field: match[2] };
}

function isImmutableNarrativeOrArchivePath(path: string) {
  return path === "optimizedScript"
    || /^storyboard\[\d+\]\.shotPurpose$/.test(path)
    || /^workflow\.(sourceAnalysis|diagnosis|editingNotes|filmScript|screenplay|concisePrompt)$/.test(path);
}

function buildWorkflowPromptFallback(result: AnalysisResult) {
  const workflow = (result.workflow || {}) as NonNullable<AnalysisResult["workflow"]>;
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  return [
    cleanText(workflow.fullVideoPrompt),
    cleanText(result.optimizedScript),
    ...storyboard.flatMap((shot) => [
      cleanText(shot.scene),
      cleanText(shot.visual),
      cleanText(shot.videoPrompt),
      cleanText(shot.firstFramePrompt),
      cleanText(shot.lastFramePrompt),
    ]),
  ].filter(Boolean).join("\n");
}

function patchStringValue(value: unknown, path: string) {
  const text = sanitizeInternalPromptTokens(cleanText(value));
  return isNegativePromptPath(path) ? normalizeNegativePrompt(text, path) : applyStringRules(text, path);
}

function patchValueForFinding(
  result: AnalysisResult,
  path: string,
  finding: BatchSegmentQualityFinding,
) {
  const currentValue = getValueAtPath(result, path);
  const shotTarget = shotIndexFromPath(path);
  if (shotTarget && Array.isArray(result.storyboard)) {
    const shot = result.storyboard[shotTarget.index];
    if (shot && typeof shot === "object") {
      const patchedShot = patchShot(shot, shotTarget.index) as Record<string, unknown>;
      if (shotTarget.field in patchedShot) return patchedShot[shotTarget.field];
    }
  }

  if (path === "workflow.fullNegativePrompt" || isNegativePromptPath(path)) {
    return normalizeNegativePrompt(currentValue, path);
  }

  if (path === "workflow.fullVideoPrompt") {
    const fallback = buildWorkflowPromptFallback(result);
    const cleaned = patchStringValue(currentValue, path);
    if (finding.code === "full_prompt_too_short" || finding.code === "empty_full_prompt") {
      return ensureTargetLength(cleaned, 900, fallback);
    }
    return cleaned;
  }

  if (typeof currentValue === "string" || currentValue === undefined || currentValue === null) {
    if (finding.code === "missing_required_field" && finding.field === "dialogue") return "无";
    return patchStringValue(currentValue, path);
  }

  return currentValue;
}

export function applyDeterministicQualityPatchWithDiff<T extends AnalysisResult>(
  result: T,
  findings: BatchSegmentQualityFinding[] = [],
): DeterministicQualityPatchResult<T> {
  let patched = result;
  const patchDiffs: QualityPatchDiff[] = [];
  const seenPaths = new Set<string>();

  for (const finding of findings) {
    if (!isPatchEligibleFinding(finding)) continue;
    const candidatePaths = finding.affectedPaths?.length ? finding.affectedPaths : [finding.path || ""];
    for (const candidatePath of candidatePaths) {
      const path = normalizePatchPath(candidatePath);
      if (!path || seenPaths.has(path)) continue;
      if (isImmutableNarrativeOrArchivePath(path)) continue;
      seenPaths.add(path);

      const before = getValueAtPath(patched, path);
      const after = patchValueForFinding(patched, path, finding);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;

      patched = setValueAtPath(patched, path, after);
      patchDiffs.push({
        path,
        code: finding.code,
        severity: finding.severity as Extract<BatchSegmentQualitySeverity, "patchable" | "risk">,
        before,
        after,
        patchSource: "local",
        reason: finding.message,
      });
    }
  }

  return { result: patched, patchDiffs };
}

export function applyDeterministicQualityPatch<T extends AnalysisResult>(
  result: T,
  findings: BatchSegmentQualityFinding[] = [],
): T {
  return applyDeterministicQualityPatchWithDiff(result, findings).result;
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
