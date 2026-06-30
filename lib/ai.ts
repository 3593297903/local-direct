import { z } from "zod";
import { buildMockAnalysis } from "@/lib/mock";
import { AI_VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT } from "@/lib/prompt-optimizer-skill";
import { durationSince, logger } from "@/lib/logger";
import type { AnalysisResult } from "@/types";

export type AnalyzeScriptInput = {
  script: string;
  contentType: string;
  style: string;
  duration: string;
  provider?: string;
  requestId?: string;
  /** LangGraph 检索后注入的知识库上下文。 */
  knowledgeContext?: string;
  /** Project-level director memory assembled from user preferences, story bible, and recent episodes. */
  directorContext?: string;
  /** Internal instruction added only after a placeholder validation failure. */
  placeholderRetryInstruction?: string;
};

function stringifyModelField(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => stringifyModelField(item)).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${stringifyModelField(item)}`)
      .join("\n");
  }
  return value;
}

const ModelString = z.preprocess((value) => stringifyModelField(value), z.string());
const OptionalModelString = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? undefined : stringifyModelField(value)),
  z.string().optional()
);
const ModelStringArray = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === "") return [];
    return [value];
  },
  z.array(ModelString)
);

const GenerationDiagnosisSchema = z.object({
  genre: OptionalModelString,
  emotions: ModelStringArray,
  pace: OptionalModelString,
  sceneKeywords: ModelStringArray,
  characterState: OptionalModelString,
  visualFocus: ModelStringArray,
  cameraStrategy: OptionalModelString,
  soundStrategy: OptionalModelString,
  avoid: ModelStringArray,
});

const NarrativeMemorySchema = z.object({
  episodeSummary: OptionalModelString,
  endingState: OptionalModelString,
  characterState: OptionalModelString,
  stateVector: z.record(z.string(), z.unknown()).optional(),
  openLoops: ModelStringArray.optional(),
  resolvedLoops: ModelStringArray.optional(),
  characters: z.array(z.record(z.string(), z.unknown())).optional(),
  storyLoops: z.array(z.record(z.string(), z.unknown())).optional(),
  memoryItems: z.array(z.record(z.string(), z.unknown())).optional(),
}).optional();

const AnalysisSchema = z.object({
  title: ModelString,
  contentType: ModelString,
  duration: ModelString,
  style: ModelString,
  diagnosis: ModelStringArray,
  optimizedScript: ModelString,
  workflow: z.object({
    sourceAnalysis: ModelString,
    generationDiagnosis: GenerationDiagnosisSchema,
    coreTheme: OptionalModelString,
    videoParameterLock: OptionalModelString,
    screenplay: ModelString,
    filmScript: ModelString,
    fullVideoPrompt: ModelString,
    fullNegativePrompt: ModelString,
    shotPromptText: OptionalModelString,
    editingPlan: OptionalModelString,
    concisePrompt: ModelString,
    finalPromptPackage: OptionalModelString,
  }).optional(),
  storyboard: z.array(z.object({
    shotNumber: z.coerce.number(),
    timeRange: OptionalModelString,
    scene: ModelString,
    visual: ModelString,
    shotType: ModelString,
    composition: OptionalModelString,
    cameraMovement: ModelString,
    lighting: OptionalModelString,
    sound: OptionalModelString,
    dialogue: OptionalModelString,
    emotion: ModelString,
    transition: ModelString,
    shotPurpose: OptionalModelString,
    firstFramePrompt: ModelString,
    videoPrompt: ModelString,
    lastFramePrompt: ModelString,
    negativePrompt: ModelString,
    concisePrompt: OptionalModelString,
  })),
  recommendedItems: ModelStringArray,
  editingNotes: ModelStringArray,
  narrativeMemory: NarrativeMemorySchema,
  qualityCheck: z.record(z.string(), z.unknown()).optional(),
});

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const match = trimmed.match(/```json([\s\S]*?)```/) || trimmed.match(/```([\s\S]*?)```/);
  if (match) return match[1].trim();

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);

  return trimmed;
}

const DOCUMENT_TEMPLATE_TASK = [
  "严格按用户提供的 Word 文档水准生成：文案分析 -> 文案到剧本 -> 剧本到专业电影脚本 -> 电影脚本到完整 AI 视频提示词。",
  "所有展示给用户的视频提示词必须使用中文。不要输出英文完整提示词，不要用英文段落替代中文描述；除 AI / JSON / 16:9 / 35mm 等必要术语外，主体内容必须是中文。",
  "总时长由系统根据文案信息密度、动作数量、情绪节奏和场景复杂度自动设计；一般控制在 8-15 秒，最高不超过 15 秒。不要把所有内容固定成 15 秒，也不要为了塞内容牺牲镜头可执行性。",
  "根据自动设计的总时长和剧情节奏决定镜头数：短时长可 3-4 个镜头，接近 15 秒优先 4-5 个镜头；信息密度高、证据链多、人物反应多时可用更多但不能超过时长上限。时间轴必须精确到小数点后一位，不能固定每个镜头 3 秒。",
  "必须完整保留原文案的因果链、人物关系、线索顺序和情绪走向。不要新增无关角色，不要把原本克制的悬疑改成怪物、鬼脸、血腥或跳吓。",
  "必须先输出段落级剧本信息：标题、总时长、场次类型、时间、地点、天气、主要人物、段落功能、场次正文、段尾衔接、导演备注、摄影备注、美术备注、声音备注。",
  "必须输出专业电影脚本：每个镜头都要有时间段、景别、机位/构图、运镜、画面内容、光影/色调、声音设计、台词、情绪、转场、镜头意图。",
  "必须输出完整视频总提示词：用中文完整成片描述，整合风格、人物、场景、天气、空间关系、关键物件、动作、镜头节奏、声音、台词、转场、生成方式。",
  "必须先完成 workflow.generationDiagnosis，再根据 generationDiagnosis 生成 workflow.shotPromptText 和 storyboard。generationDiagnosis 要判断片种、情绪、节奏、场景关键词、人物状态、视觉重点、运镜策略、声音策略和避免项。",
  "workflow.shotPromptText 必须直接写成最终展示模板，格式固定为：核心主题、技术参数、镜头画面 + 时间轴 + 声音 / 台词。不要在这个字段里写第一步、第二步、第三步，也不要写英文视频提示词。",
  "workflow.shotPromptText 的技术参数部分请逐行输出；总时长、画幅、帧率必须始终输出；其他技术参数只在原文或 generationDiagnosis 能够判断时输出，没有明确依据的内容不要强行补充，不要为了填满字段而编造天气、人物、地点、禁忌项。",
  "必须输出每个镜头的完整中文可复制提示词：包括首帧提示词、本镜头视频提示词、尾帧提示词、负面提示词、精简提示词。",
  "最终全部提示词汇总必须完整展开所有内容，不能写“如上”“见上文”“同上”“略”“占位符”“{变量名}”。",
  "悬疑刑侦题材禁止血腥猎奇：不拍尸体正脸、不拍腐烂细节、不拍血浆、不拍伤口和器官。用白布轮廓、担架、水迹、水草、记录本、警戒线、人物反应、环境声表现。",
  "参考用户文档写法：小超市门外村民围着警方争执，赤脚村民扛铁锨走出人群，脚上沾湿泥，声音不大却让人群安静；警员用长杆勾住水草和白布边缘，几人合力拖上岸，白布湿透滴水，警方隔离围观者，苏眉只看衣物体态后判断。你要把这种具体动作、物件、环境声音和克制反应写进输出。",
  "输出严格 JSON，不要 Markdown，不要代码块，不要解释文字。",
].join("\n");

const requiredJsonShape = {
  title: "标题，例如：河中谜影 / 关键证言 / 黄土高原早春",
  contentType: "内容类型，例如：小说剧情 / 悬疑刑侦 / 电影悬疑",
  duration: "系统根据文案自动设计的视频时长，例如：8秒 / 12秒 / 14.5秒，必须不超过15秒",
  style: "风格，例如：中式现实刑侦悬疑、冷写实电影质感、低饱和",
  diagnosis: [
    "原文案分析 / 问题诊断：类型、主题、人物、核心线索、视觉线索、情绪推进、原文缺少哪些镜头/运镜/光影/声音信息",
  ],
  optimizedScript: "完整视频总提示词，必须完整展示，不要只写摘要",
  workflow: {
    sourceAnalysis:
      "原文案分析：类型、主题、人物、地点、时间、天气、冲突、证言/证据、关键视觉线索、改编策略。",
    generationDiagnosis: {
      genre: "片种判断，例如：悬疑 / 剧情 / 爱情 / 科幻 / 日常。必须来自原文和题材气质。",
      emotions: ["主要情绪，例如：紧张、不安、释然、温暖。只写能从原文判断出的情绪。"],
      pace: "节奏判断，例如：缓慢、克制、中速、快速。根据事件密度和情绪节奏判断。",
      sceneKeywords: ["场景关键词，例如：雨夜、废弃大楼、室内房间。没有明确依据不要编造。"],
      characterState: "人物状态，例如：迟疑、震惊、疲惫、释然。根据动作和心理判断。",
      visualFocus: ["视觉重点，例如：旧照片、门缝、脚步、背影、灯光。"],
      cameraStrategy: "运镜策略，例如：缓慢推进、固定观察、手持跟拍。服务镜头情绪和叙事功能。",
      soundStrategy: "声音策略，例如：雨声、脚步声、呼吸声、低沉环境声。服务场景和情绪。",
      avoid: ["避免项，例如：血腥、鬼脸、jump scare、无关现代元素。根据题材风险判断。"],
    },
    coreTheme:
      "核心主题：用一段话概括本段要表现的核心事件、情绪和叙事作用。",
    videoParameterLock:
      "视频参数锁定：技术参数部分请逐行输出；总时长、画幅、帧率必须始终输出；其他技术参数只在原文或 generationDiagnosis 能够判断时输出，没有明确依据的内容不要强行补充，不要为了填满字段而编造天气、人物、地点、禁忌项。",
    screenplay:
      "第一步：文案 -> 剧本。必须包含标题、时长、场次类型、时间、地点、天气、主要人物、段落功能、场次一/场次二正文、段尾衔接、导演备注、摄影备注、美术备注、声音备注。",
    filmScript:
      "第二步：剧本 -> 电影脚本。逐镜头列出：时间段、场景功能、画面、景别、机位/构图、运镜、光影/色调、声音/台词、镜头意图。",
    fullVideoPrompt:
      "第三步：电影脚本 -> 完整 AI 视频总提示词。必须是完整中文成片描述，整合风格、人物、场景、时间、天气、镜头语言、声音、节奏、转场、生成方式。",
    fullNegativePrompt:
      "完整负面提示词：针对题材和画面风险定制，不要泛泛而谈。",
    shotPromptText:
      "最终视频生成提示词：只写最终展示模板，不写中间步骤。固定包含：核心主题、技术参数、镜头画面 + 时间轴 + 声音 / 台词。每个镜头按“0s-4s｜镜头1｜景别/机位｜镜头标题”展开，并写画面、声音、台词、这一镜作用。必须是中文。",
    editingPlan:
      "剪辑建议：镜头之间如何衔接、声音如何转场、节奏如何控制、哪里硬切、哪里动作匹配或声音延续。",
    concisePrompt:
      "精简版总提示词：适合直接复制到视频模型，但仍要保留主体、场景、风格、镜头节奏和禁忌项。",
    finalPromptPackage:
      "最终全部提示词汇总：完整汇总核心主题、视频参数锁定、整体风格、完整视频总提示词、负面提示词、镜头画面+时间轴+声音/台词、每个镜头完整提示词、剪辑建议、精简版提示词。禁止写如上、同上、略、占位符。",
  },
  storyboard: [
    {
      shotNumber: 1,
      timeRange: "0.0s-3.4s",
      scene: "场景/场次功能",
      visual: "画面内容，必须具体可见",
      shotType: "景别，例如：中景 / 特写 / 远景",
      composition: "机位/构图",
      cameraMovement: "运镜",
      lighting: "光影/色调",
      sound: "声音设计",
      dialogue: "台词，没有则写无",
      emotion: "情绪",
      transition: "转场",
      shotPurpose: "镜头意图",
      firstFramePrompt: "首帧提示词",
      videoPrompt: "本镜头完整可复制 AI 视频提示词",
      lastFramePrompt: "尾帧提示词",
      negativePrompt: "本镜头负面提示词",
      concisePrompt: "本镜头精简提示词",
    },
  ],
  recommendedItems: ["推荐生成方式、镜头、运镜、转场"],
  editingNotes: ["生成建议、剪辑建议、声音设计、容易翻车点和解决方式"],
};

type StringValueEntry = {
  path: string;
  value: string;
};

type PlaceholderRule = {
  label: string;
  pattern: RegExp;
};

const placeholderRules: PlaceholderRule[] = [
  { label: "如上", pattern: /如上/ },
  { label: "见上文", pattern: /见上文/ },
  { label: "同上", pattern: /同上/ },
  { label: "占位符", pattern: /占位符/ },
  { label: "placeholder", pattern: /placeholder/i },
  { label: "略", pattern: /(?:^|[。；,，\s])略(?:[。；,，\s]|$)/ },
  { label: "{变量名}", pattern: /\{\s*(?:xxx|变量名|placeholder|TODO)\s*\}/i },
  { label: "{{...}}", pattern: /\{\{\s*[^}]+\s*\}\}/ },
];

export class TemplatePlaceholderError extends Error {
  path: string;
  matchedText: string;
  snippet: string;

  constructor(path: string, matchedText: string, snippet: string) {
    super(
      `AI output contains incomplete template placeholder at ${path}: matched "${matchedText}". ` +
        `Please regenerate with complete prompt text. Snippet: ${snippet}`,
    );
    this.name = "TemplatePlaceholderError";
    this.path = path;
    this.matchedText = matchedText;
    this.snippet = snippet;
  }
}

function collectStringValues(value: unknown, path = "result"): StringValueEntry[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectStringValues(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      collectStringValues(item, path === "result" ? key : `${path}.${key}`),
    );
  }
  return [];
}

function snippetAround(value: string, matchIndex: number, matchLength: number) {
  const start = Math.max(0, matchIndex - 36);
  const end = Math.min(value.length, matchIndex + matchLength + 36);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < value.length ? "..." : "";
  return `${prefix}${value.slice(start, end)}${suffix}`;
}

function findTemplatePlaceholder(result: AnalysisResult) {
  for (const entry of collectStringValues(result)) {
    for (const rule of placeholderRules) {
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(entry.value);
      if (!match) continue;
      return {
        path: entry.path,
        matchedText: match[0].trim() || rule.label,
        snippet: snippetAround(entry.value, match.index, match[0].length),
      };
    }
  }
  return null;
}

export function assertNoTemplatePlaceholders(result: AnalysisResult) {
  const found = findTemplatePlaceholder(result);
  if (found) {
    throw new TemplatePlaceholderError(found.path, found.matchedText, found.snippet);
  }
}

function stringContainsTemplatePlaceholder(value: string) {
  return placeholderRules.some((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(value);
  });
}

function buildStoryboardPromptPackage(result: AnalysisResult) {
  return result.storyboard
    .map((shot) =>
      [
        `镜头 ${shot.shotNumber}${shot.timeRange ? `｜${shot.timeRange}` : ""}`,
        shot.scene ? `场景：${shot.scene}` : "",
        shot.visual ? `画面：${shot.visual}` : "",
        shot.shotType ? `景别：${shot.shotType}` : "",
        shot.composition ? `机位/构图：${shot.composition}` : "",
        shot.cameraMovement ? `运镜：${shot.cameraMovement}` : "",
        shot.lighting ? `光影/色调：${shot.lighting}` : "",
        shot.sound ? `声音：${shot.sound}` : "",
        shot.dialogue ? `台词：${shot.dialogue}` : "",
        shot.emotion ? `情绪：${shot.emotion}` : "",
        shot.transition ? `转场：${shot.transition}` : "",
        shot.shotPurpose ? `镜头目的：${shot.shotPurpose}` : "",
        shot.firstFramePrompt ? `首帧提示词：${shot.firstFramePrompt}` : "",
        shot.videoPrompt ? `视频提示词：${shot.videoPrompt}` : "",
        shot.lastFramePrompt ? `尾帧提示词：${shot.lastFramePrompt}` : "",
        shot.negativePrompt ? `负面提示词：${shot.negativePrompt}` : "",
        shot.concisePrompt ? `精简提示词：${shot.concisePrompt}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function buildFinalPromptPackage(result: AnalysisResult) {
  const workflow = result.workflow;
  const storyboardPromptPackage = buildStoryboardPromptPackage(result);
  const parts = [
    ["核心主题", workflow?.coreTheme || result.title],
    ["视频参数锁定", workflow?.videoParameterLock || `总时长：${result.duration}\n整体风格：${result.style}`],
    ["整体风格", result.style],
    ["完整视频总提示词", workflow?.fullVideoPrompt || result.optimizedScript],
    ["负面提示词", workflow?.fullNegativePrompt],
    ["镜头画面 + 时间轴 + 声音/台词", workflow?.shotPromptText || storyboardPromptPackage],
    ["每个镜头完整提示词", storyboardPromptPackage],
    ["剪辑建议", workflow?.editingPlan || result.editingNotes?.join("\n")],
    ["精简版提示词", workflow?.concisePrompt || result.recommendedItems?.join("\n")],
  ] as const;

  return parts
    .flatMap(([title, value]) => {
      if (typeof value !== "string" || !value.trim()) return [];
      return [`${title}\n${value.trim()}`];
    })
    .join("\n\n");
}

export function repairTemplatePlaceholders<T extends AnalysisResult>(result: T): T {
  const finalPromptPackage = result.workflow?.finalPromptPackage;
  if (!finalPromptPackage || !stringContainsTemplatePlaceholder(finalPromptPackage)) {
    return result;
  }

  return {
    ...result,
    workflow: {
      ...result.workflow,
      finalPromptPackage: buildFinalPromptPackage(result),
    },
  };
}

function isTemplatePlaceholderError(error: unknown): error is TemplatePlaceholderError {
  return error instanceof TemplatePlaceholderError || (error instanceof Error && error.name === "TemplatePlaceholderError");
}

function buildPlaceholderRetryInstruction(error: TemplatePlaceholderError) {
  return [
    "上一次输出因为存在未展开模板占位内容被拒绝，请重新生成完整 JSON。",
    `问题字段：${error.path}`,
    `命中内容：${error.matchedText}`,
    "要求：所有字段必须写完整，不允许写如上、见上文、同上、略、占位符、placeholder、{变量名} 或 {{...}}。",
    "尤其要完整展开 workflow.finalPromptPackage、每个镜头的 videoPrompt、firstFramePrompt、lastFramePrompt 和 negativePrompt。",
  ].join("\n");
}

export async function runWithTemplatePlaceholderRetry<T>(
  operation: (attempt: number, retryInstruction?: string) => Promise<T>,
  context: { requestId?: string; provider?: string; model?: string } = {},
) {
  const maxRetries = 5;
  let retryInstruction: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation(attempt, retryInstruction);
    } catch (error) {
      if (!isTemplatePlaceholderError(error) || attempt >= maxRetries) throw error;
      retryInstruction = buildPlaceholderRetryInstruction(error);
      logger.warn("ai_provider_placeholder_retry", {
        requestId: context.requestId,
        provider: context.provider,
        model: context.model,
        attempt: attempt + 1,
        maxRetries,
        placeholderPath: error.path,
        placeholderText: error.matchedText,
      });
    }
  }

  throw new Error("AI placeholder retry finished without returning a result");
}

export class AIProviderNetworkError extends Error {
  provider: string;
  model: string;
  baseUrl: string;
  causeMessage: string;

  constructor(context: { provider: string; model: string; baseUrl: string; cause: unknown }) {
    const causeMessage = context.cause instanceof Error ? context.cause.message : String(context.cause);
    super(
      `AI provider network request failed for ${context.provider} (model ${context.model}) at ${context.baseUrl}. ` +
        `The Next.js server could not reach the AI service. Check network, proxy/VPN, firewall, DNS, or AI_BASE_URL. ` +
        `Cause: ${causeMessage}`,
    );
    this.name = "AIProviderNetworkError";
    this.provider = context.provider;
    this.model = context.model;
    this.baseUrl = context.baseUrl;
    this.causeMessage = causeMessage;
  }
}

function numberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withFetchTimeout(init: RequestInit) {
  const timeoutMs = numberFromEnv("AI_REQUEST_TIMEOUT_MS", 120_000);
  if (!timeoutMs || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return init;
  if (init.signal) return init;
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

export async function fetchAiProvider(
  url: string,
  init: RequestInit,
  context: { requestId?: string; provider: string; model: string; baseUrl: string },
) {
  const maxRetries = 1;
  const retryDelayMs = numberFromEnv("AI_NETWORK_RETRY_DELAY_MS", 350);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetch(url, withFetchTimeout(init));
    } catch (error) {
      if (attempt >= maxRetries) {
        logger.error("ai_provider_network_failed", {
          requestId: context.requestId,
          provider: context.provider,
          model: context.model,
          baseUrl: context.baseUrl,
          attempt: attempt + 1,
          maxRetries,
          error,
        });
        throw new AIProviderNetworkError({ ...context, cause: error });
      }

      logger.warn("ai_provider_network_retry", {
        requestId: context.requestId,
        provider: context.provider,
        model: context.model,
        baseUrl: context.baseUrl,
        attempt: attempt + 1,
        maxRetries,
        error,
      });
      if (retryDelayMs) await sleep(retryDelayMs);
    }
  }

  throw new AIProviderNetworkError({ ...context, cause: "fetch retry loop ended without response" });
}

function estimateDurationSeconds(script: string) {
  const compact = script.replace(/\s+/g, "");
  const sentenceCount = script
    .split(/[。！？；;?\n]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;

  if (compact.length <= 45 && sentenceCount <= 2) return 8;
  if (compact.length <= 90 && sentenceCount <= 4) return 10;
  if (compact.length <= 160 && sentenceCount <= 7) return 12;
  if (compact.length <= 260 && sentenceCount <= 10) return 14;
  return 15;
}

export function normalizeDuration(duration: string | undefined, script: string) {
  const match = String(duration || "").match(/\d+(?:\.\d+)?/);
  const rawSeconds = match ? Number(match[0]) : estimateDurationSeconds(script);
  const seconds = Math.min(15, Math.max(4, Number.isFinite(rawSeconds) ? rawSeconds : estimateDurationSeconds(script)));
  return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}秒`;
}

function parseDurationSeconds(duration: string) {
  const match = duration.match(/\d+(?:\.\d+)?/);
  const seconds = match ? Number(match[0]) : 15;
  return Number.isFinite(seconds) ? Math.min(15, Math.max(4, seconds)) : 15;
}

function formatDurationSeconds(seconds: number) {
  return Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
}

function buildDurationBudgetRange(duration: string) {
  const upperSeconds = parseDurationSeconds(duration);
  const lowerSeconds = Math.max(4, upperSeconds - 1);
  return `${formatDurationSeconds(lowerSeconds)}-${formatDurationSeconds(upperSeconds)}秒`;
}

export function normalizeAnalysisInput<T extends Pick<AnalyzeScriptInput, "script" | "duration">>(input: T): T & { duration: string } {
  return { ...input, duration: normalizeDuration(input.duration, input.script) };
}

function buildShotCountGuidance(input: Pick<AnalyzeScriptInput, "script" | "duration">) {
  const duration = normalizeDuration(input.duration, input.script);
  const durationRange = buildDurationBudgetRange(duration);
  return [
    `用户选择的视频时长上限是 ${duration}。这个时长是镜头设计预算上限，不是必须精确等于 ${duration}；实际总时长允许在 ${durationRange} 内，由文案节奏、动作密度和情绪停顿决定。`,
    `基础视频规格必须锁定：画幅：16:9；帧率：24fps；总时长请从 ${durationRange} 内选择最合适的一位小数时间。整体范围仍限制在 4-15 秒，最低不能低于 4 秒，最高不能超过所选上限。`,
    "先分析文案节拍：事件数量、动作数量、场景变化、情绪转折、关键物件、台词密度和信息复杂度。",
    "不要按固定区间机械决定镜头数；不要因为 13-15 秒就固定 5 个镜头，也不要因为 4-6 秒就固定 2 个镜头。",
    "镜头数量必须服务文案：极简情绪或单一动作可以用 1 个连续镜头；普通短段落可用 2-4 个镜头；信息密度高、人物反应多、线索推进多时可用 4-5 个镜头。",
    "所选时长代表上限前 1 秒到上限之间的可用预算，例如 15 秒可生成 14.0-15.0 秒，8 秒可生成 7.0-8.0 秒；如果选择 4 秒，实际总时长就按 4.0 秒设计。",
    `每个镜头都必须有明确叙事功能；时间轴总和不要强制等于所选总时长，只要落在 ${durationRange} 内即可，并精确到小数点后一位。`,
  ].join("\n");
}

function directorContextInstruction(input: Pick<AnalyzeScriptInput, "directorContext">) {
  if (!input.directorContext) {
    return "未提供连续剧导演上下文，请只根据当前文案生成。";
  }

  return [
    "directorContext 是系统保存的导演档案，不是用户新输入文案。",
    "请用它保持人物状态、地点道具、视觉风格、上一集结尾和未解决线索的连续性。",
    "当前 script 永远优先；不要机械复述历史剧情，不要把历史完整提示词搬进输出。",
    "最终仍按原有 JSON 结构生成，不要新增字段，不要改变 fullVideoPrompt 的模板定位。",
  ].join("\n");
}

async function callOpenAICompatible(input: AnalyzeScriptInput & { provider: string }) {
  const provider = input.provider.trim();
  const baseUrl = (process.env.AI_BASE_URL || (provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1")).trim();
  const model = (process.env.AI_MODEL || (provider === "deepseek" ? "deepseek-chat" : "gpt-4.1-mini")).trim();
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("Missing AI_API_KEY");
  const startedAt = Date.now();
  logger.info("ai_provider_request_started", {
    requestId: input.requestId,
    provider,
    model,
    scriptLength: input.script.length,
    knowledgeContextLength: input.knowledgeContext?.length || 0,
    directorContextLength: input.directorContext?.length || 0,
  });

  const res = await fetchAiProvider(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.18,
      max_tokens: Number(process.env.AI_MAX_TOKENS || 22000),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AI_VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            task: [DOCUMENT_TEMPLATE_TASK, buildShotCountGuidance(input)].join("\n\n"),
            contentType: input.contentType,
            style: input.style,
            duration: input.duration,
            script: input.script,
            knowledgeContext: input.knowledgeContext || "",
            directorContext: input.directorContext || "",
            directorContextInstruction: directorContextInstruction(input),
            hiddenMemoryInstruction:
              "You may add only hidden system fields narrativeMemory and qualityCheck for project memory. Do not mix narrativeMemory or qualityCheck into workflow.shotPromptText or workflow.fullVideoPrompt.",
            knowledgeInstruction: input.knowledgeContext
              ? "必须优先参考 knowledgeContext 中的镜头、运镜、转场、风格、公式和避免事项；不要逐字照抄，要结合用户文案自然改写；avoid/必须避免内容要进入负面提示词。"
              : "未提供额外知识库上下文，请按通用导演规则生成。",
            retryInstruction: input.placeholderRetryInstruction || undefined,
            requiredJsonShape,
          }),
        },
      ],
    }),
  }, {
    requestId: input.requestId,
    provider,
    model,
    baseUrl,
  });

  if (!res.ok) {
    const errorText = await res.text();
    logger.error("ai_provider_request_failed", {
      requestId: input.requestId,
      provider,
      model,
      status: res.status,
      durationMs: durationSince(startedAt),
      error: errorText,
    });
    throw new Error(`AI request failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI returned empty content");

  const parsed = JSON.parse(extractJson(content));
  const result = repairTemplatePlaceholders(AnalysisSchema.parse(parsed));
  assertNoTemplatePlaceholders(result);
  logger.info("ai_provider_request_completed", {
    requestId: input.requestId,
    provider,
    model,
    durationMs: durationSince(startedAt),
    storyboardCount: result.storyboard.length,
  });
  return result;
}

async function callAnthropic(input: AnalyzeScriptInput) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("Missing AI_API_KEY");

  const provider = "anthropic";
  const baseUrl = "https://api.anthropic.com";
  const model = (process.env.AI_MODEL || "claude-3-5-sonnet-latest").trim();
  const startedAt = Date.now();
  logger.info("ai_provider_request_started", {
    requestId: input.requestId,
    provider,
    model,
    scriptLength: input.script.length,
    knowledgeContextLength: input.knowledgeContext?.length || 0,
    directorContextLength: input.directorContext?.length || 0,
  });
  const res = await fetchAiProvider(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": process.env.ANTHROPIC_API_VERSION || "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(process.env.AI_MAX_TOKENS || 22000),
      temperature: 0.18,
      system: AI_VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            task: [DOCUMENT_TEMPLATE_TASK, buildShotCountGuidance(input)].join("\n\n"),
            contentType: input.contentType,
            style: input.style,
            duration: input.duration,
            script: input.script,
            knowledgeContext: input.knowledgeContext || "",
            directorContext: input.directorContext || "",
            directorContextInstruction: directorContextInstruction(input),
            hiddenMemoryInstruction:
              "You may add only hidden system fields narrativeMemory and qualityCheck for project memory. Do not mix narrativeMemory or qualityCheck into workflow.shotPromptText or workflow.fullVideoPrompt.",
            knowledgeInstruction: input.knowledgeContext
              ? "必须优先参考 knowledgeContext 中的镜头、运镜、转场、风格、公式和避免事项；不要逐字照抄，要结合用户文案自然改写；avoid/必须避免内容要进入负面提示词。"
              : "未提供额外知识库上下文，请按通用导演规则生成。",
            retryInstruction: input.placeholderRetryInstruction || undefined,
            requiredJsonShape,
          }),
        },
      ],
    }),
  }, {
    requestId: input.requestId,
    provider,
    model,
    baseUrl,
  });

  if (!res.ok) {
    const errorText = await res.text();
    logger.error("ai_provider_request_failed", {
      requestId: input.requestId,
      provider,
      model,
      status: res.status,
      durationMs: durationSince(startedAt),
      error: errorText,
    });
    throw new Error(`Anthropic request failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  const text = data.content?.map((c: { text?: string }) => c.text).join("\n") || "";
  const parsed = JSON.parse(extractJson(text));
  const result = repairTemplatePlaceholders(AnalysisSchema.parse(parsed));
  assertNoTemplatePlaceholders(result);
  logger.info("ai_provider_request_completed", {
    requestId: input.requestId,
    provider,
    model,
    durationMs: durationSince(startedAt),
    storyboardCount: result.storyboard.length,
  });
  return result;
}

export async function analyzeScriptDirect(input: AnalyzeScriptInput): Promise<AnalysisResult> {
  const provider = input.provider || process.env.AI_PROVIDER || "mock";
  const normalizedInput = normalizeAnalysisInput(input);
  if (provider === "mock") return buildMockAnalysis(normalizedInput);
  if (provider === "anthropic") {
    return runWithTemplatePlaceholderRetry(
      (_attempt, placeholderRetryInstruction) => callAnthropic({ ...normalizedInput, placeholderRetryInstruction }),
      { requestId: input.requestId, provider: "anthropic" },
    );
  }
  return runWithTemplatePlaceholderRetry(
    (_attempt, placeholderRetryInstruction) => callOpenAICompatible({ ...normalizedInput, provider, placeholderRetryInstruction }),
    { requestId: input.requestId, provider },
  );
}

export async function analyzeScript(input: AnalyzeScriptInput): Promise<AnalysisResult> {
  if (process.env.AI_WORKFLOW === "direct") {
    return analyzeScriptDirect(input);
  }

  const { invokeVideoDirectorGraph } = await import("@/lib/agent/video-director-graph");
  return invokeVideoDirectorGraph(input);
}
