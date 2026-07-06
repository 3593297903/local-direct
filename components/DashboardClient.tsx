"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { AnalysisResult, KnowledgeItem, StoryboardShot } from "@/types";
import { CopyButton } from "@/components/CopyButton";
import { Drawer } from "@/components/Drawer";
import { PreviewAnimation } from "@/components/PreviewAnimation";
import { matchShotReferences, ShotReferenceMatches } from "@/lib/reference-matcher";
import { Clock, Download, FileText, Film, ImageIcon, Loader2, Maximize2, ScanLine, Send, ShieldCheck, SlidersHorizontal, X } from "lucide-react";

type StoryboardImageState = {
  sheetUrl: string;
  prompt: string;
  panels: Record<number, string>;
};

type ProjectSaveState = {
  saved?: boolean;
  projectId?: string;
  versionId?: string;
  versionNumber?: number;
  reason?: string;
};

type StoryboardCodexPanel = {
  id: string;
  shotNumber: number;
  batchIndex?: number;
  batchTotal?: number;
  prompt?: string;
  size?: string;
  quality?: string;
  status: "pending" | "running" | "completed" | "failed";
  imageUrl?: string | null;
  error?: string | null;
  attempts?: number;
  sourceImagePath?: string | null;
  outputHash?: string | null;
  imageFingerprint?: string | null;
  codexLogPath?: string | null;
  duplicateOfPanelId?: string | null;
};

type StoryboardCodexJob = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  prompt?: string;
  sheetUrl?: string | null;
  error?: string | null;
  panels: StoryboardCodexPanel[];
};

type VideoPromptCodexJob = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: AnalysisResult | null;
  error?: string | null;
};

type VideoPromptPackCodexJob = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  result?: {
    segments: Array<{
      episodeIndex: number;
      outputPath: string;
      result: AnalysisResult;
    }>;
  } | null;
  error?: string | null;
};

type SeasonPackEpisodeResult = {
  episodeIndex: number;
  fileName: string;
  input: SeasonPackEpisodeInput;
};

type SeasonPackEpisodeInput = {
  episodeIndex: number;
  title: string;
  sourceText: string;
  duration: string;
  contentType: string;
  style: string;
  storyBible: unknown;
  episodeChain: unknown;
  blueprint: unknown;
  shotCount: number;
  renderInputScript: string;
};

type SeasonPackCodexJob = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  segmentCountMode?: SegmentCountMode;
  requestedEpisodeCount?: number | null;
  resolvedEpisodeCount?: number | null;
  episodeCount: number;
  result?: {
    episodes: SeasonPackEpisodeResult[];
    manifest?: Record<string, unknown> | null;
    seasonPlan?: Record<string, unknown> | null;
  } | null;
  error?: string | null;
};

type PromptSafetyOptimizationResult = {
  targetModel: string;
  status: "PASSED" | "OPTIMIZED" | "BLOCKED_NEEDS_USER_EDIT";
  riskLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  findings: Array<{
    field: string;
    shotNumber?: number;
    original: string;
    reason: string;
    replacement?: string;
    severity?: "low" | "medium" | "high";
  }>;
  changeSummary: string[];
  optimizedResult: AnalysisResult;
};

type PromptSafetyCodexJob = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: PromptSafetyOptimizationResult | null;
  error?: string | null;
};

class CodexVideoPromptJobFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexVideoPromptJobFailedError";
  }
}

type BatchPromptSection = {
  segment: {
    index: number;
    text: string;
  };
  result: AnalysisResult;
  promptText: string;
};

type DurationMode = "auto" | "fixed";
type SegmentCountMode = "fixed" | "auto";
type RenderPackCodexMode = "standard" | "strictUtf8";
type BatchGenerationPhase = "planning" | "rendering" | "repairing" | "saving" | "completed" | "failed";
type BatchSegmentStatus = "pending" | "running" | "repairing" | "cached" | "completed" | "saving" | "saved" | "failed";
type BatchRepairReasonType =
  | "encoding"
  | "schema"
  | "segment-label"
  | "duration"
  | "shot-density"
  | "quality"
  | "render-pack";

type BatchSegmentProgress = {
  index: number;
  title?: string;
  status: BatchSegmentStatus;
  message?: string;
};

type BatchGenerationProgress = {
  mode: SegmentCountMode;
  phase: BatchGenerationPhase;
  requestedCount: number | null;
  resolvedSegmentCount: number | null;
  completedCount: number;
  runningCount: number;
  pendingCount: number;
  repairingCount: number;
  savingCount: number;
  currentMessage: string;
  segments: BatchSegmentProgress[];
};

const MAX_EPISODE_BATCH_COUNT = 30;
const BATCH_RENDER_PACK_SIZE = 4;
const BATCH_RENDER_PACK_CONCURRENCY = 4;
const BATCH_SINGLE_RENDER_CONCURRENCY = 3;
const SLOW_RENDER_PACK_WARNING_MS = 8 * 60_000;
const STRICT_UTF8_RENDER_PACK_MODE: RenderPackCodexMode = "strictUtf8";
const MIN_BATCH_FULL_PROMPT_LENGTH = 1400;
const BATCH_SEGMENT_CACHE_PREFIX = "localdirector:segment-batch:";
const segmentTerminologyPattern = /(?:\u7b2c\s*[0-9\u4e00-\u9fa5]+\s*\u96c6|\u672c\u96c6|\u5355\u96c6|\u5267\u96c6)/;
const GENERIC_SEASON_TEMPLATE_PHRASES = [
  "人物、地点和关键物件按案件逻辑分层",
  "缓慢推进后停住",
  "同期环境声、脚步声、纸张声或市场声",
  "保留北方县城真实空间感",
];
const REQUIRED_BATCH_SEGMENT_SHOT_FIELDS = [
  "timeRange",
  "scene",
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
const MIN_BATCH_FIELD_LENGTHS: Partial<Record<(typeof REQUIRED_BATCH_SEGMENT_SHOT_FIELDS)[number], number>> = {
  scene: 8,
  visual: 36,
  composition: 24,
  cameraMovement: 2,
  lighting: 20,
  sound: 16,
  emotion: 4,
  transition: 2,
  shotPurpose: 20,
  firstFramePrompt: 24,
  videoPrompt: 60,
  lastFramePrompt: 24,
  negativePrompt: 16,
};

const CODEX_QUOTA_EXHAUSTED_CODE = "CODEX_QUOTA_EXHAUSTED";
const CODEX_QUOTA_EXHAUSTED_DISPLAY_MESSAGE = "Codex 额度已用完或暂时受限，请恢复额度后再继续生成。";
const CODEX_QUOTA_ERROR_PATTERN =
  /CODEX_QUOTA_EXHAUSTED|Codex 额度已用完|insufficient[_\s-]?quota|usage limit|rate\s*limit|limit reached|billing|credits?|RESOURCE_EXHAUSTED|429/i;

const particleColors = [
  "rgba(129, 140, 248, 0.45)",
  "rgba(167, 139, 250, 0.45)",
  "rgba(244, 114, 182, 0.42)",
  "rgba(14, 165, 233, 0.45)",
  "rgba(192, 132, 252, 0.45)",
];

const workspaceParticles = Array.from({ length: 56 }, (_, index) => {
  const color = particleColors[index % particleColors.length];
  return {
    color,
    left: `${(index * 37 + 11) % 100}%`,
    top: `${(index * 53 + 17) % 100}%`,
    size: `${4 + ((index * 7) % 14)}px`,
    delay: `${-((index * 0.37) % 8)}s`,
    duration: `${15 + ((index * 5) % 20)}s`,
  };
});

function particleStyle(particle: (typeof workspaceParticles)[number]) {
  return {
    "--particle-left": particle.left,
    "--particle-top": particle.top,
    "--particle-size": particle.size,
    "--particle-delay": particle.delay,
    "--particle-duration": particle.duration,
    "--particle-color": particle.color,
  } as CSSProperties;
}

function calculateStoryboardCodexTimeoutMs(job: StoryboardCodexJob) {
  return Math.max(30 * 60_000, job.panels.length * 8 * 60_000);
}

function formatUserFacingError(message: unknown, fallback = "生成失败") {
  const text = typeof message === "string" ? message : message instanceof Error ? message.message : "";
  if (text.includes(CODEX_QUOTA_EXHAUSTED_CODE) || CODEX_QUOTA_ERROR_PATTERN.test(text)) {
    return CODEX_QUOTA_EXHAUSTED_DISPLAY_MESSAGE;
  }
  return text || fallback;
}

function ReferenceItemButton({ item, onSelect }: { item: KnowledgeItem; onSelect: (item: KnowledgeItem) => void }) {
  return (
    <button
      onClick={() => onSelect(item)}
      className="group overflow-hidden rounded-xl border border-cyan-300/14 bg-slate-950/70 text-left transition hover:border-cyan-200/55 hover:bg-cyan-300/[0.06]"
    >
      <PreviewAnimation item={item} type={item.previewType} playback="hover" />
      <div className="p-3">
        <div className="text-xs text-cyan-200/70">{item.category}</div>
        <div className="mt-1 font-bold text-white">{item.name}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded-md border border-white/8 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300">
              {tag}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

function ReferenceSection({
  title,
  items,
  emptyText,
  onSelect,
}: {
  title: string;
  items: KnowledgeItem[];
  emptyText: string;
  onSelect: (item: KnowledgeItem) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-bold text-white">{title}</h4>
        <span className="rounded-full border border-cyan-300/14 bg-cyan-300/8 px-2.5 py-1 text-xs text-cyan-100">{items.length} 个参考</span>
      </div>
      {items.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <ReferenceItemButton key={item.id} item={item} onSelect={onSelect} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-cyan-300/16 bg-slate-950/60 p-4 text-sm text-slate-500">{emptyText}</div>
      )}
    </div>
  );
}

function ResultTextBlock({
  title,
  text,
  copyLabel,
}: {
  title: string;
  text?: string;
  copyLabel?: string;
}) {
  if (!text) return null;

  return (
    <div className="section-shell rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold text-white">{title}</h3>
        {copyLabel && <CopyButton text={text} label={copyLabel} />}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-7 text-slate-300">{text}</p>
    </div>
  );
}

function buildVideoGenerationPromptText(result: AnalysisResult) {
  const workflow = result.workflow;
  const title = cleanPromptValue(result.title, "未命名视频提示词");
  const duration = cleanPromptValue(result.duration, "15秒");
  const style = cleanPromptValue(result.style, "电影级写实");
  const contentType = cleanPromptValue(result.contentType, "短剧 / 通用");
  const coreTheme = cleanPromptValue(workflow?.coreTheme, "") || `${title}：围绕原文案核心事件，保持人物关系、线索顺序和情绪推进，生成一段可直接执行的 AI 视频提示词。`;
  const technicalParams =
    cleanPromptValue(workflow?.videoParameterLock, "") ||
    [
      `总时长：${duration}`,
      "画幅：16:9",
      `风格：${style}`,
      `场景：${contentType}对应的主要空间，保持原文案地点、时间、天气和人物关系一致。`,
      "运镜原则：按线索推进顺序设计镜头，由空间建立到关键动作，再到人物反应和段尾转场。",
      "光影原则：根据题材控制主色调、明暗层次和真实光源，不使用突兀过曝或廉价特效。",
      "声音原则：以真实环境声、动作声和必要台词为主，不使用喧宾夺主的背景音乐。",
      "画面表达重点：用空间、动作、物件、人物反应和镜头节奏表达剧情，不依赖血腥、怪物、突脸惊吓或无关元素。",
    ].join("\n");

  const shotLines = (Array.isArray(result.storyboard) ? result.storyboard : [])
    .map(
      (shot) =>
        `${shot.timeRange || "-"}｜镜头${shot.shotNumber}｜${shot.shotType || "镜头"}｜${shot.scene || shot.shotPurpose || "剧情推进"}

${shot.visual || shot.videoPrompt}
${shot.composition ? `机位/构图：${shot.composition}` : ""}
${shot.cameraMovement ? `运镜：${shot.cameraMovement}` : ""}
${shot.lighting ? `光影：${shot.lighting}` : ""}
声音：${shot.sound || "真实环境声。"}
台词：${shot.dialogue || "无台词。"}
这一镜作用：${shot.shotPurpose || "推动剧情信息，让观众顺着画面线索进入下一镜。"}`
    )
    .join("\n\n");

  return [
    `核心主题\n\n${coreTheme}`,
    `技术参数\n\n${technicalParams}`,
    `镜头画面 + 时间轴 + 声音 / 台词\n${shotLines}`,
  ].filter(Boolean).join("\n\n");
}

function cleanPromptValue(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null" || /\bundefined\b/.test(trimmed)) return fallback;
  return trimmed;
}

function sanitizeBatchSegmentText(value: string) {
  return value
    .replace(/\u7b2c\s*([0-9\u4e00-\u9fa5]+)\s*\u96c6/g, "\u7b2c$1\u6bb5")
    .replace(/\u672c\u96c6/g, "\u672c\u6bb5")
    .replace(/\u5355\u96c6/g, "\u5355\u6bb5")
    .replace(/\u5267\u96c6/g, "\u5206\u6bb5");
}

function sanitizeBatchSegmentOutput<T>(value: T): T {
  if (typeof value === "string") return sanitizeBatchSegmentText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeBatchSegmentOutput(item)) as T;
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeBatchSegmentOutput(item)]),
  ) as T;
}

function classifyBatchRepairReason(reason: string): BatchRepairReasonType {
  if (/encoding|question marks|replacement characters|UTF-?8|parse|JSON/i.test(reason)) return "encoding";
  if (/missing|required|optimizedScript|workflow\.fullVideoPrompt|storyboard\[\d+\]|field|schema/i.test(reason)) return "schema";
  if (segmentTerminologyPattern.test(reason) || /episode terminology|segment label/i.test(reason)) return "segment-label";
  if (/duration|seconds|15\s*s|15\s*\u79d2|\u65f6\u957f/i.test(reason)) return "duration";
  if (/shot count|shot density|too many shots|\u955c\u5934/i.test(reason)) return "shot-density";
  if (/Render Pack|did not produce|output file|pack/i.test(reason)) return "render-pack";
  return "quality";
}

function batchRepairReasonLabel(reasonType: BatchRepairReasonType) {
  const labels: Record<BatchRepairReasonType, string> = {
    encoding: "\u7f16\u7801\u4fee\u590d",
    schema: "\u5b57\u6bb5\u4fee\u590d",
    "segment-label": "\u6bb5\u843d\u7f16\u53f7\u4fee\u590d",
    duration: "\u65f6\u957f\u4fee\u590d",
    "shot-density": "\u955c\u5934\u5bc6\u5ea6\u4fee\u590d",
    quality: "\u8d28\u91cf\u4fee\u590d",
    "render-pack": "Render Pack \u4fee\u590d",
  };
  return labels[reasonType];
}

function normalizeBatchEpisodeResult(
  baseScript: string,
  episodeIndex: number,
  episodeCount: number,
  result: AnalysisResult,
  requestedDuration: string,
) {
  const sourceInfo = inferBatchEpisodeSourceInfo(baseScript, episodeIndex);
  const title = cleanPromptValue(result.title, "")
    || titleFromGeneratedText(result.optimizedScript)
    || sourceInfo.title
    || `第${episodeIndex}段`;
  const duration = cleanPromptValue(result.duration, "")
    || durationFromGeneratedText(result.optimizedScript)
    || sourceInfo.duration
    || normalizePromptDuration(requestedDuration)
    || "15秒";
  const contentType = cleanPromptValue(result.contentType, "")
    || inferPromptContentType(baseScript)
    || "短剧 / 通用";
  const style = cleanPromptValue(result.style, "")
    || inferPromptStyle(baseScript)
    || "电影级写实";
  const workflow = result.workflow ? { ...result.workflow } : undefined;
  const normalizedWorkflow = workflow
    ? {
      ...workflow,
      coreTheme: cleanPromptValue(workflow.coreTheme, "")
        || `${title}：围绕原文案核心事件，保持人物关系、线索顺序和情绪推进，生成一段可直接执行的 AI 视频提示词。`,
      videoParameterLock: cleanPromptValue(workflow.videoParameterLock, "")
        || [
          `总时长：${duration}`,
          "画幅：16:9",
          `风格：${style}`,
          `场景：${contentType}对应的主要空间，保持原文案地点、时间、天气和人物关系一致。`,
        ].join("\n"),
    }
    : undefined;

  const normalized = {
    ...result,
    title,
    duration,
    contentType,
    style,
    workflow: normalizedWorkflow,
    recommendedItems: Array.isArray(result.recommendedItems) ? result.recommendedItems : [],
    editingNotes: Array.isArray(result.editingNotes) ? result.editingNotes : [],
    diagnosis: Array.isArray(result.diagnosis) ? result.diagnosis : [],
    storyboard: Array.isArray(result.storyboard) ? result.storyboard : [],
  } as AnalysisResult;

  return sanitizeBatchSegmentOutput(normalized);
}

function inferBatchEpisodeSourceInfo(baseScript: string, episodeIndex: number) {
  const lines = baseScript.replace(/\r\n?/g, "\n").split("\n");
  let active = false;
  let title = "";
  let duration = "";
  let shotCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const segmentMatch = matchPromptSourceSegmentHeading(line);
    if (segmentMatch) {
      active = segmentMatch.episodeIndex === episodeIndex;
      if (active) {
        title = `第${episodeIndex}段｜${cleanSourceTitle(segmentMatch.title)}`;
        shotCount = 0;
      }
      continue;
    }
    if (!active) continue;
    const durationMatch = line.match(/^(?:总时长|时长)\s*[：:]\s*(\d+(?:\.\d+)?)\s*秒/);
    if (durationMatch) duration = `${formatPromptSeconds(Number(durationMatch[1]))}秒`;
    const shotMatch = matchPromptSourceShotLine(line);
    if (shotMatch) {
      shotCount += 1;
      if (shotMatch.endSeconds !== undefined) duration = `${formatPromptSeconds(shotMatch.endSeconds)}秒`;
    }
  }

  return { title, duration, shotCount };
}

function matchPromptSourceSegmentHeading(line: string) {
  const match = line.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*(?:段|集)\s*(?:[｜|:：\-—]\s*)?(.+)?$/);
  if (!match) return null;
  const episodeIndex = parsePromptLocalizedInteger(match[1]);
  if (!episodeIndex) return null;
  return { episodeIndex, title: match[2] || `第${episodeIndex}段` };
}

function matchPromptSourceShotLine(line: string) {
  const match = line.match(
    /^(\d+(?:\.\d+)?|(?:\d{1,2}:)?\d{1,2}:\d{2})\s*(?:s|秒)?\s*[-—~～至到]\s*(\d+(?:\.\d+)?|(?:\d{1,2}:)?\d{1,2}:\d{2})\s*(?:s|秒)?\s*(?:[｜|:：\-—]\s*)?镜头\s*[0-9一二三四五六七八九十百]+/,
  );
  if (match) return { endSeconds: parsePromptTimecodeSeconds(match[2]) };
  return /^镜头\s*[0-9一二三四五六七八九十百]+(?:\s*[｜|:：\-—]|$)/.test(line)
    ? { endSeconds: undefined }
    : null;
}

function titleFromGeneratedText(value: unknown) {
  const text = cleanPromptValue(value, "");
  const pipeMatch = text.match(/第\s*(\d+)\s*(?:集|段)\s*[｜|]\s*([^。\n]+)/);
  if (pipeMatch) return `第${Number(pipeMatch[1])}段｜${cleanSourceTitle(pipeMatch[2])}`;
  const bracketMatch = text.match(/第\s*(\d+)\s*集\s*[《"]?([^》"\n：:]{2,40})/);
  if (bracketMatch) return `第${Number(bracketMatch[1])}段｜${cleanSourceTitle(bracketMatch[2])}`;
  return "";
}

function durationFromGeneratedText(value: unknown) {
  const text = cleanPromptValue(value, "");
  const match = text.match(/时长\s*[：:]\s*(\d+(?:\.\d+)?)\s*秒/);
  return match ? `${formatPromptSeconds(Number(match[1]))}秒` : "";
}

function normalizePromptDuration(value: string) {
  const text = cleanPromptValue(value, "");
  if (!text || /^auto$/i.test(text)) return "";
  if (/^\d+(?:\.\d+)?$/.test(text)) return `${text}秒`;
  return text;
}

function parsePromptDurationSeconds(value: unknown) {
  const text = cleanPromptValue(value, "");
  if (!text || /^auto$/i.test(text)) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|seconds?)/i) || text.match(/^(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : 0;
}

function parsePromptTimecodeSeconds(value: string) {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function parsePromptLocalizedInteger(value: string) {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (text === "十") return 10;
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const left = text.slice(0, tenIndex);
    const right = text.slice(tenIndex + 1);
    const tens = left ? digits[left] : 1;
    const ones = right ? digits[right] : 0;
    if (tens === undefined || ones === undefined) return 0;
    return tens * 10 + ones;
  }
  return digits[text] || 0;
}

function minimumBatchStoryboardShotCount(result: AnalysisResult, requestedDuration: string) {
  const seconds = parsePromptDurationSeconds(result.duration) || parsePromptDurationSeconds(requestedDuration);
  if (!seconds) return 0;
  if (seconds <= 8) return 2;
  if (seconds <= 20) return 4;
  if (seconds <= 60) return 5;
  return 6;
}

function maximumBatchStoryboardShotCount(result: AnalysisResult, requestedDuration: string) {
  const seconds = parsePromptDurationSeconds(result.duration) || parsePromptDurationSeconds(requestedDuration);
  if (!seconds) return 0;
  if (seconds <= 8) return 3;
  if (seconds <= 20) return 5;
  if (seconds <= 60) return 8;
  return 0;
}

function comparableBatchShotText(value: unknown) {
  return cleanPromptValue(value, "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、“”‘’《》【】（）()|｜\-—_]/g, "")
    .toLowerCase();
}

function minimumBatchFullPromptLength(storyboard: unknown[]) {
  if (storyboard.length >= 4) return MIN_BATCH_FULL_PROMPT_LENGTH;
  if (storyboard.length === 3) return 1100;
  return 900;
}

function assertBatchShotFieldLength(episodeIndex: number, shotIndex: number, field: string, value: unknown) {
  const minimum = MIN_BATCH_FIELD_LENGTHS[field as keyof typeof MIN_BATCH_FIELD_LENGTHS];
  if (!minimum) return;
  const text = cleanPromptValue(value, "").replace(/\s+/g, "");
  if (text.length < minimum) {
    throw new Error(
      `第 ${episodeIndex} 段生成失败：镜头 ${shotIndex + 1} 的 ${field} 字段过短，疑似摘要版，至少需要 ${minimum} 个有效字符。`,
    );
  }
}

function assertBatchSegmentQuality(
  baseScript: string,
  episodeIndex: number,
  result: AnalysisResult,
  requestedDuration: string,
) {
  const sourceInfo = inferBatchEpisodeSourceInfo(baseScript, episodeIndex);
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  const maximumShotCount = maximumBatchStoryboardShotCount(result, requestedDuration);
  if (maximumShotCount > 0 && storyboard.length > maximumShotCount) {
    throw new Error(`第 ${episodeIndex} 段生成失败：15 秒默认 4-5 镜头，当前 ${storyboard.length} 个镜头过密。`);
  }
  if (sourceInfo.shotCount > 0 && (!maximumShotCount || sourceInfo.shotCount <= maximumShotCount) && storyboard.length !== sourceInfo.shotCount) {
    throw new Error(`第 ${episodeIndex} 段生成失败：源文案有 ${sourceInfo.shotCount} 个镜头，但结果只有 ${storyboard.length} 个镜头。`);
  }
  const minimumShotCount = sourceInfo.shotCount > 0 ? 0 : minimumBatchStoryboardShotCount(result, requestedDuration);
  if (minimumShotCount > 0 && storyboard.length < minimumShotCount) {
    throw new Error(`第 ${episodeIndex} 段生成失败：镜头数量过少，至少需要 ${minimumShotCount} 个，实际 ${storyboard.length} 个。`);
  }

  const fullPrompt = buildVideoGenerationPromptText(result);
  const serializedResult = JSON.stringify(result);
  const qualityText = `${fullPrompt}\n${serializedResult}`;
  if (/\b(?:undefined|null)\b/i.test(serializedResult)) {
    throw new Error(`Segment ${episodeIndex} failed quality check: serialized result contains undefined/null.`);
  }
  if (segmentTerminologyPattern.test(serializedResult)) {
    throw new Error(`Segment ${episodeIndex} failed quality check: serialized result still contains episode terminology.`);
  }
  if (/\b(?:undefined|null)\b/i.test(qualityText)) {
    throw new Error(`第 ${episodeIndex} 段生成失败：提示词中包含 undefined/null 字段。`);
  }
  if (/16\s*:\s*9\s*竖屏|竖屏\s*16\s*:\s*9|横屏\s*竖屏/.test(fullPrompt)) {
    throw new Error(`第 ${episodeIndex} 段生成失败：提示词包含 16:9 竖屏这类自相矛盾描述。`);
  }
  if (/如上|同上|见上文|其他\s*[：:]\s*无|其它\s*[：:]\s*无|^\s*略\s*$/m.test(fullPrompt)) {
    throw new Error(`第 ${episodeIndex} 段生成失败：提示词包含如上/同上/略等不可执行占位。`);
  }
  if (/第\s*[0-9一二三四五六七八九十百]+\s*集/.test(fullPrompt)) {
    throw new Error(`第 ${episodeIndex} 段生成失败：提示词混入了“第 X 集”编号，应统一为“第 X 段”。`);
  }
  const minimumFullPrompt = minimumBatchFullPromptLength(storyboard);
  if (fullPrompt.length < minimumFullPrompt) {
    throw new Error(`第 ${episodeIndex} 段生成失败：完整视频提示词过短，疑似摘要版，至少需要 ${minimumFullPrompt} 字。`);
  }
  const templateHits = GENERIC_SEASON_TEMPLATE_PHRASES.reduce(
    (count, phrase) => count + fullPrompt.split(phrase).length - 1,
    0,
  );
  if (templateHits >= 2) {
    throw new Error(`第 ${episodeIndex} 段生成失败：提示词仍是模板化概要，没有生成具体镜头。`);
  }

  const seenVisuals = new Map<string, number>();
  storyboard.forEach((shot, index) => {
    for (const field of REQUIRED_BATCH_SEGMENT_SHOT_FIELDS) {
      const value = shot[field];
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`第 ${episodeIndex} 段生成失败：镜头 ${index + 1} 缺少 ${field} 字段。`);
      }
      assertBatchShotFieldLength(episodeIndex, index, field, value);
    }
    const visual = comparableBatchShotText(shot.visual || shot.videoPrompt);
    if (!visual || visual.length < 24) return;
    const previous = seenVisuals.get(visual);
    if (previous !== undefined) {
      throw new Error(`第 ${episodeIndex} 段生成失败：镜头 ${previous + 1} 和镜头 ${index + 1} 的画面重复。`);
    }
    seenVisuals.set(visual, index);
  });
}

function inferPromptContentType(sourceText: string) {
  if (/刑侦|公安|警局|投案|案/.test(sourceText)) return "短剧 / 刑侦惊悚";
  if (/惊悚|恐怖|旅馆|悬疑/.test(sourceText)) return "短剧 / 悬疑惊悚";
  if (/短剧/.test(sourceText)) return "短剧 / 通用";
  return "";
}

function inferPromptStyle(sourceText: string) {
  const explicitStyle = sourceText.match(/(?:风格|类型)\s*[：:]\s*([^\n]+)/);
  if (explicitStyle?.[1]) return explicitStyle[1].trim();
  if (/中式现实刑侦惊悚片|悲剧收束/.test(sourceText)) return "中式现实刑侦惊悚片 / 悲剧收束";
  if (/现实主义|现实/.test(sourceText) && /惊悚|悬疑/.test(sourceText)) return "现实主义悬疑惊悚，冷静克制";
  return "";
}

function cleanSourceTitle(value: string) {
  return value
    .replace(/^第\s*[0-9一二三四五六七八九十百]+\s*(?:段|集)\s*(?:[｜|:：\-—]\s*)?/, "")
    .replace(/^["'《「“]+|["'》」”]+$/g, "")
    .trim();
}

function formatPromptSeconds(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function clampEpisodeCount(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_EPISODE_BATCH_COUNT, Math.max(1, Math.round(value)));
}

function chunkEpisodesForRenderPacks<T>(items: T[], size = BATCH_RENDER_PACK_SIZE) {
  const chunks: T[][] = [];
  const chunkSize = Math.max(1, size);
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildBatchEpisodeScript(baseScript: string, episodeIndex: number, episodeCount: number) {
  const source = baseScript.trim();
  return [
    source,
    "",
    "批量分段生成要求：",
    `这是同一个项目连续生成任务中的第 ${episodeIndex} / ${episodeCount} 段。`,
    "请只生成当前这一段的完整视频提示词，不要输出其他段。",
    "如果后端提供了项目记忆，请承接上一段结尾、人物状态、线索、世界观和视觉风格。",
    "最终标题和提示词必须使用“段”，不要写“第 N 集”或“本集”。",
    "15 秒默认 4-5 镜头；除非用户明确选择密集镜头版，否则 10-20 秒最多 5 个镜头。",
    episodeIndex === 1
      ? "本段需要建立核心设定、主要人物关系和本轮剧情钩子。"
      : episodeIndex === episodeCount
        ? "本段需要承接前段并完成本轮情绪收束，结尾可以保留下一轮钩子。"
        : "本段需要承接前段并推进新的行动、线索或人物关系变化。",
  ].join("\n");
}

function buildBatchEpisodeRenderScript(episodeInput: SeasonPackEpisodeInput, episodeCount: number) {
  return [
    episodeInput.renderInputScript,
    "",
    "多段批量生成一致性锁：",
    `这是第 ${episodeInput.episodeIndex} / ${episodeCount} 段。`,
    "你现在必须按普通单段生成的完整质量输出，不允许输出短版、摘要版或规划说明。",
    "最终标题、核心主题和完整视频提示词必须使用“第 N 段”，不要写“第 N 集”。",
    "15 秒默认 4-5 镜头；除非用户明确选择密集镜头版，否则 10-20 秒最多 5 个镜头。",
    `最终 storyboard 必须严格等于 ${episodeInput.shotCount} 个镜头。`,
    "最终输出必须是 Local Director AnalysisResult JSON，由本地视频提示词 Codex worker 写入文件。",
  ].join("\n");
}

function buildBatchSegmentRepairScript(renderScript: string, episodeIndex: number, episodeCount: number, reason: string, failedResult: AnalysisResult) {
  return [
    renderScript,
    "",
    "当前段生成结果未通过 Local Director 保存前质量闸门，需要只重修当前段。",
    `当前段：第 ${episodeIndex} / ${episodeCount} 段。`,
    `失败原因：${reason}`,
    "",
    "重修要求：",
    "1. 不要重写成新故事，只修当前段提示词和 storyboard。",
    "2. 保留原段人物、地点、事件顺序、情绪推进和项目记忆。",
    "3. 每个镜头必须补齐 timeRange、scene、visual、shotType、composition、cameraMovement、lighting、sound、dialogue、emotion、transition、shotPurpose、firstFramePrompt、videoPrompt、lastFramePrompt、negativePrompt。",
    "4. 没有台词时 dialogue 必须写“无”。",
    "5. 最终标题和提示词必须使用“第 N 段”，不要写“第 N 集”。",
    "6. 15 秒默认 4-5 镜头；除非用户明确要求密集镜头版，否则 10-20 秒最多 5 个镜头。",
    "7. 不要出现 undefined、null、如上、同上、略、其他：无、16:9竖屏。",
    "",
    "未通过校验的上次结果摘要：",
    JSON.stringify({
      title: failedResult.title,
      duration: failedResult.duration,
      style: failedResult.style,
      storyboardCount: Array.isArray(failedResult.storyboard) ? failedResult.storyboard.length : 0,
      optimizedScript: failedResult.optimizedScript,
    }, null, 2),
  ].join("\n");
}

function episodeSourceText(baseScript: string, episodeIndex: number, episodeCount: number, episodeInput: SeasonPackEpisodeInput, episodeResult: AnalysisResult) {
  return [
    `整段规划 + 单段同款生成：第 ${episodeIndex} / ${episodeCount} 段`,
    `本段规划标题：${episodeInput.title}`,
    `本段标题：${episodeResult.title}`,
    "",
    "本段原文案：",
    episodeInput.sourceText,
    "",
    "本段生成结果摘要：",
    episodeResult.optimizedScript,
  ].join("\n");
}

export function DashboardClient() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [script, setScript] = useState("一个男人在雨夜收到一张旧照片，发现照片里的人竟然是多年后死去的自己。他沿着照片背后的地址，走进一栋废弃大楼。");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [batchResults, setBatchResults] = useState<BatchPromptSection[]>([]);
  const [libraryItems, setLibraryItems] = useState<KnowledgeItem[]>([]);
  const [storyboardImage, setStoryboardImage] = useState<StoryboardImageState | null>(null);
  const [projectSave, setProjectSave] = useState<ProjectSaveState | null>(null);
  const [resumeProjectId, setResumeProjectId] = useState("");
  const [resumeVersionId, setResumeVersionId] = useState("");
  const [creatingNewEpisode, setCreatingNewEpisode] = useState(false);
  const creatingNewEpisodeRef = useRef(false);
  const [selectedShot, setSelectedShot] = useState<StoryboardShot | null>(null);
  const [referenceShot, setReferenceShot] = useState<StoryboardShot | null>(null);
  const [selectedLibraryItem, setSelectedLibraryItem] = useState<KnowledgeItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [uploadingText, setUploadingText] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [durationMode, setDurationMode] = useState<DurationMode>("auto");
  const [durationSeconds, setDurationSeconds] = useState(15);
  const [durationPickerOpen, setDurationPickerOpen] = useState(false);
  const [episodeCount, setEpisodeCount] = useState(1);
  const [segmentCountMode, setSegmentCountMode] = useState<SegmentCountMode>("fixed");
  const [batchProgress, setBatchProgress] = useState<BatchGenerationProgress | null>(null);
  const [episodeCountPickerOpen, setEpisodeCountPickerOpen] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [generationProgress, setGenerationProgress] = useState("");
  const [error, setError] = useState("");
  const [imageError, setImageError] = useState("");
  const [promptSafetyLoading, setPromptSafetyLoading] = useState(false);
  const [promptSafetyMessage, setPromptSafetyMessage] = useState("");
  const [promptSafetyError, setPromptSafetyError] = useState("");
  const [libraryError, setLibraryError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/library")
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (!data.ok) throw new Error(data.error || "参考库加载失败");
        setLibraryItems(data.items || []);
      })
      .catch((err) => {
        if (active) setLibraryError(err.message || "参考库加载失败");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const resumeScript = window.localStorage.getItem("vd_resume_script");
    const resumeProject = window.localStorage.getItem("vd_resume_project_id");
    const resumeVersion = window.localStorage.getItem("vd_resume_version_id");
    const newEpisodeMode = window.localStorage.getItem("vd_new_episode");
    const creatingEpisodeFromProject = newEpisodeMode === "1" || Boolean(resumeProject && !resumeScript);
    if (resumeProject && !resumeScript) {
      setScript("");
      setResumeProjectId(resumeProject || "");
      setResumeVersionId("");
      creatingNewEpisodeRef.current = creatingEpisodeFromProject;
      setCreatingNewEpisode(creatingEpisodeFromProject);
      setGenerationProgress("已选择历史项目，新输入文案后会生成下一段。");
      window.localStorage.removeItem("vd_new_episode");
      window.localStorage.removeItem("vd_resume_script");
      window.localStorage.removeItem("vd_resume_project_id");
      window.localStorage.removeItem("vd_resume_version_id");
      return;
    }
    if (resumeScript) {
      setScript(resumeScript);
      setResumeProjectId(resumeProject || "");
      setResumeVersionId(resumeVersion || "");
      creatingNewEpisodeRef.current = false;
      setCreatingNewEpisode(false);
      setGenerationProgress(resumeVersion ? "已载入当前分段，可修改后重新生成这一段。" : "已载入历史文案，可继续编辑。");
      window.localStorage.removeItem("vd_new_episode");
      window.localStorage.removeItem("vd_resume_script");
      window.localStorage.removeItem("vd_resume_project_id");
      window.localStorage.removeItem("vd_resume_version_id");
    }
  }, []);

  function getActiveResumeVersionId() {
    return creatingNewEpisodeRef.current ? undefined : resumeVersionId || undefined;
  }

  function selectedDurationValue() {
    return durationMode === "auto" ? "auto" : `${durationSeconds}秒`;
  }

  function updateEpisodeCount(value: number) {
    setSegmentCountMode("fixed");
    setEpisodeCount(clampEpisodeCount(value));
  }

  async function requestAnalysis(inputScript: string, inputDuration: string) {
    return requestAnalysisWithContext(
      inputScript,
      inputDuration,
      resumeProjectId || undefined,
      getActiveResumeVersionId(),
    );
  }

  async function requestAnalysisWithContext(
    inputScript: string,
    inputDuration: string,
    projectId: string | undefined = resumeProjectId || undefined,
    versionId: string | undefined = resumeVersionId || undefined,
  ) {
    return requestAnalysisWithProviderFallback(inputScript, inputDuration, projectId, versionId);
  }

  async function createVideoPromptCodexJob(
    inputScript: string,
    inputDuration: string,
    projectId: string | undefined,
    versionId: string | undefined,
  ) {
    const res = await fetch("/api/video-prompt/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script: inputScript,
        duration: inputDuration,
        projectId: projectId || undefined,
        versionId: versionId || undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Codex 视频提示词任务创建失败");
    }
    return data.job as VideoPromptCodexJob;
  }

  async function createVideoPromptPackCodexJob(
    segments: Array<{
      episodeIndex: number;
      title: string;
      script: string;
      renderInputScript: string;
      duration: string;
      shotCount: number;
    }>,
    projectId: string | undefined,
    mode: RenderPackCodexMode = STRICT_UTF8_RENDER_PACK_MODE,
  ) {
    const res = await fetch("/api/video-prompt-packs/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectId || undefined,
        mode,
        segments,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Codex render pack job creation failed");
    }
    return data.job as VideoPromptPackCodexJob;
  }

  async function createSeasonPackCodexJob(
    inputScript: string,
    inputDuration: string,
    projectId: string | undefined,
    mode: SegmentCountMode,
    requestedCount: number,
  ) {
    const body: Record<string, unknown> = {
      script: inputScript,
      duration: inputDuration,
      segmentCountMode: mode,
      projectId: projectId || undefined,
    };
    if (mode === "fixed") body.episodeCount = requestedCount;

    const res = await fetch("/api/season-pack/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Codex 整段提示词任务创建失败");
    }
    return data.job as SeasonPackCodexJob;
  }

  async function pollSeasonPackCodexJob(jobId: string, mode: SegmentCountMode, requestedCount: number) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(45 * 60_000, (mode === "auto" ? MAX_EPISODE_BATCH_COUNT : requestedCount) * 3 * 60_000);
    let lastStatus = "";

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/season-pack/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Codex 整段提示词任务读取失败");
      }

      const currentJob = data.job as SeasonPackCodexJob;
      if (currentJob.status !== lastStatus) {
        lastStatus = currentJob.status;
        setGenerationProgress(
          currentJob.status === "running"
            ? mode === "auto"
              ? "Codex 正在分析原文结构并自动判断分段数量..."
              : `Codex 正在一次性生成 ${currentJob.episodeCount || requestedCount} 段视频提示词文件包...`
            : `Codex 整段提示词任务状态：${currentJob.status}`,
        );
      }
      if (currentJob.status === "completed") return currentJob;
      if (currentJob.status === "failed") {
        throw new Error(currentJob.error || "Codex 整段提示词任务失败");
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    throw new Error("Codex 整段提示词任务等待超时，请确认 season-pack:codex-worker 正在运行。");
  }

  function isMissingLockedSeasonPlanError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /locked beat plan|beats|lockedSegments|SegmentPlan/i.test(message);
  }

  function isRecoverableRenderPackError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!message || CODEX_QUOTA_ERROR_PATTERN.test(message)) return false;
    return /encoding|question marks|replacement characters|JSON|parse|missing|optimizedScript|workflow\.fullVideoPrompt|storyboard|did not produce|output file/i.test(message);
  }

  function renderPackDurationMs(job: VideoPromptPackCodexJob) {
    const startedAt = Date.parse(job.startedAt || job.createdAt || "");
    const completedAt = Date.parse(job.completedAt || job.updatedAt || "");
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
    return Math.max(0, completedAt - startedAt);
  }

  async function pollVideoPromptPackCodexJob(jobId: string, segmentCount: number) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(30 * 60_000, segmentCount * 600_000);
    let lastStatus = "";

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/video-prompt-packs/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Codex render pack job read failed");
      }

      const currentJob = data.job as VideoPromptPackCodexJob;
      if (currentJob.status !== lastStatus) {
        lastStatus = currentJob.status;
        setGenerationProgress(
          currentJob.status === "running"
            ? `Codex 正在本地生成 ${segmentCount} 段 Render Pack...`
            : `Codex Render Pack 任务状态：${currentJob.status}`,
        );
      }
      if (currentJob.status === "completed") return currentJob;
      if (currentJob.status === "failed") {
        throw new CodexVideoPromptJobFailedError(currentJob.error || "Codex render pack job failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    throw new Error("Codex Render Pack 任务等待超时，请确认 video-prompt-pack:codex-worker 正在运行。");
  }

  async function pollVideoPromptCodexJob(jobId: string) {
    const startedAt = Date.now();
    const timeoutMs = 20 * 60_000;
    let lastStatus = "";

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/video-prompt/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Codex 视频提示词任务读取失败");
      }

      const currentJob = data.job as VideoPromptCodexJob;
      if (currentJob.status !== lastStatus) {
        lastStatus = currentJob.status;
        setGenerationProgress(
          currentJob.status === "running"
            ? "Codex 正在本地生成视频提示词..."
            : `Codex 视频提示词任务状态：${currentJob.status}`,
        );
      }
      if (currentJob.status === "completed") return currentJob;
      if (currentJob.status === "failed") {
        throw new CodexVideoPromptJobFailedError(currentJob.error || "Codex 视频提示词任务失败");
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    throw new Error("Codex 视频提示词任务等待超时，请确认 video-prompt:codex-worker 正在运行。");
  }

  async function requestAnalysisWithProviderFallback(
    inputScript: string,
    inputDuration: string,
    projectId: string | undefined,
    versionId: string | undefined,
  ) {
    try {
      const job = await createVideoPromptCodexJob(inputScript, inputDuration, projectId, versionId);
      setGenerationProgress("已创建 Codex 视频提示词任务，请确认 video-prompt:codex-worker 正在运行。");
      const completedJob = await pollVideoPromptCodexJob(job.id);
      if (!completedJob.result) {
        throw new CodexVideoPromptJobFailedError("Codex 视频提示词任务完成但没有生成结果");
      }
      setResult(completedJob.result as AnalysisResult);
      return completedJob.result as AnalysisResult;
    } catch (err) {
      if (err instanceof CodexVideoPromptJobFailedError) throw err;
      console.warn("video-prompt codex endpoint unavailable, falling back to /api/analyze", err);
      setGenerationProgress("本地 Codex 视频提示词入口暂不可用，正在回退到在线模型生成。");
      return requestAnalysisViaProvider(inputScript, inputDuration, projectId, versionId);
    }
  }

  async function requestAnalysisViaProvider(
    inputScript: string,
    inputDuration: string,
    projectId: string | undefined,
    versionId: string | undefined,
  ) {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script: inputScript,
        duration: inputDuration,
        projectId: projectId || undefined,
        versionId: versionId || undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || `在线模型生成失败：${res.status}`);
    }
    return data.result as AnalysisResult;
  }

  async function createPromptSafetyCodexJob(
    sourceResult: AnalysisResult,
    promptText: string,
    projectId: string | undefined,
    versionId: string | undefined,
  ) {
    const res = await fetch("/api/prompt-safety/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectId || undefined,
        versionId: versionId || undefined,
        targetModel: "SEEDANCE_2_0",
        promptText,
        sourceResult,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Seedance 合规优化任务创建失败");
    }
    return data.job as PromptSafetyCodexJob;
  }

  async function pollPromptSafetyCodexJob(jobId: string) {
    const startedAt = Date.now();
    const timeoutMs = 20 * 60_000;
    let lastStatus = "";

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/prompt-safety/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Seedance 合规优化任务读取失败");
      }

      const currentJob = data.job as PromptSafetyCodexJob;
      if (currentJob.status !== lastStatus) {
        lastStatus = currentJob.status;
        setPromptSafetyMessage(
          currentJob.status === "running"
            ? "Codex 正在本地优化 Seedance 2.0 合规提示词..."
            : `Seedance 合规优化任务状态：${currentJob.status}`,
        );
      }
      if (currentJob.status === "completed") return currentJob;
      if (currentJob.status === "failed") throw new Error(currentJob.error || "Seedance 合规优化任务失败");
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    throw new Error("Seedance 合规优化任务等待超时，请确认 prompt-safety:codex-worker 正在运行。");
  }

  async function runSeedancePromptSafetyOptimization() {
    if (!result) return;
    setPromptSafetyLoading(true);
    setPromptSafetyError("");
    setPromptSafetyMessage("已创建 Seedance 合规优化准备任务，请确认 prompt-safety:codex-worker 正在运行。");

    try {
      const promptText = buildVideoGenerationPromptText(result);
      const job = await createPromptSafetyCodexJob(result, promptText, projectSave?.projectId, projectSave?.versionId);
      const completedJob = await pollPromptSafetyCodexJob(job.id);
      const safetyResult = completedJob.result;
      const optimizedResult = safetyResult?.optimizedResult;
      if (!safetyResult || !optimizedResult) {
        throw new Error("Seedance 合规优化完成但没有返回优化结果");
      }
      if (safetyResult.status === "BLOCKED_NEEDS_USER_EDIT") {
        const reason = safetyResult.findings.map((finding) => finding.reason).filter(Boolean).join("；");
        throw new Error(reason || "当前提示词无法自动合规改写，需要先调整原始文案");
      }

      const optimizedPromptText = buildVideoGenerationPromptText(optimizedResult);
      setResult(optimizedResult);
      if (projectSave?.projectId && projectSave?.versionId) {
        const save = await saveAnalysisProject(script, optimizedResult, optimizedPromptText, projectSave.projectId, projectSave.versionId);
        setProjectSave(save);
      }
      setPromptSafetyMessage(
        `Seedance 合规优化完成：${safetyResult.findings.length} 处风险记录，${safetyResult.changeSummary.length} 条修改说明。`,
      );
    } catch (err) {
      setPromptSafetyError(formatUserFacingError(err, "Seedance 合规优化失败"));
    } finally {
      setPromptSafetyLoading(false);
    }
  }

  async function saveAnalysisProject(
    originalScript: string,
    analysisResult: AnalysisResult,
    fullVideoPrompt: string,
    projectId: string | undefined = resumeProjectId || undefined,
    versionId: string | undefined = getActiveResumeVersionId(),
  ): Promise<ProjectSaveState> {
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          versionId,
          originalScript,
          result: analysisResult,
          fullVideoPrompt,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        return { saved: false, reason: data?.error || "Project save failed" };
      }
      return (data.save || { saved: true }) as ProjectSaveState;
    } catch (err) {
      return {
        saved: false,
        reason: err instanceof Error ? err.message : "Project save failed",
      };
    }
  }

  async function runBatchEpisodeGeneration() {
    const completed: BatchPromptSection[] = [];
    let activeProjectId = resumeProjectId || "";
    const latestSaveRef: { current: ProjectSaveState | null } = { current: null };
    const mode = segmentCountMode;
    const requestedCount = mode === "auto" ? null : episodeCount;
    let resolvedSegmentCount = requestedCount || null;
    let segmentProgressItems: BatchSegmentProgress[] = [];
    setBatchGenerating(true);

    function publishBatchProgress(phase: BatchGenerationPhase, currentMessage: string) {
      const completedCount = segmentProgressItems.filter((item) => ["cached", "completed", "saving", "saved"].includes(item.status)).length;
      const runningCount = segmentProgressItems.filter((item) => item.status === "running").length;
      const repairingCount = segmentProgressItems.filter((item) => item.status === "repairing").length;
      const savingCount = segmentProgressItems.filter((item) => item.status === "saving").length;
      const pendingCount = segmentProgressItems.filter((item) => item.status === "pending").length;
      setBatchProgress({
        mode,
        phase,
        requestedCount,
        resolvedSegmentCount,
        completedCount,
        runningCount,
        pendingCount,
        repairingCount,
        savingCount,
        currentMessage,
        segments: segmentProgressItems,
      });
      setGenerationProgress(currentMessage);
    }

    function updateSegmentProgress(index: number, status: BatchSegmentStatus, message?: string) {
      segmentProgressItems = segmentProgressItems.map((item) =>
        item.index === index ? { ...item, status, message } : item,
      );
    }

    publishBatchProgress(
      "planning",
      mode === "auto" ? "正在分析原文结构，自动判断适合生成多少段..." : `正在创建 ${episodeCount} 段整段规划任务...`,
    );

    async function runSeasonPackPlanningWithLockedRetry() {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const job = await createSeasonPackCodexJob(script, selectedDurationValue(), activeProjectId || undefined, mode, episodeCount);
        setGenerationProgress(`已创建整段规划任务 ${job.id}，请确认 season-pack:codex-worker 正在运行。`);
        publishBatchProgress("planning", `已创建整段规划任务 ${job.id}，请确认 season-pack:codex-worker 正在运行。`);
        try {
          return await pollSeasonPackCodexJob(job.id, mode, episodeCount);
        } catch (error) {
          lastError = error;
          if (attempt >= 2 || !isMissingLockedSeasonPlanError(error)) {
            throw error;
          }
          publishBatchProgress("planning", "分段锁定失败，正在重新规划全局 Beat 排程...");
        }
      }
      throw lastError instanceof Error ? lastError : new Error("分段锁定失败，请重新生成。");
    }

    const seasonPackJob = await runSeasonPackPlanningWithLockedRetry();
    const batchCacheKey = `${BATCH_SEGMENT_CACHE_PREFIX}${seasonPackJob.id}`;
    const episodes = [...(seasonPackJob.result?.episodes || [])].sort((left, right) => left.episodeIndex - right.episodeIndex);
    resolvedSegmentCount = episodes.length;
    if (mode === "fixed" && episodes.length !== episodeCount) {
      throw new Error(`整段规划任务完成但段数不完整：${episodes.length} / ${episodeCount}`);
    }
    if (mode === "auto" && (episodes.length < 1 || episodes.length > MAX_EPISODE_BATCH_COUNT)) {
      throw new Error(`自动分段任务完成但识别段数异常：${episodes.length}`);
    }
    segmentProgressItems = episodes.map((episode) => ({
      index: episode.episodeIndex,
      title: episode.input.title,
      status: "pending" as const,
      message: "等待单段质量生成",
    }));
    publishBatchProgress("rendering", `已识别 ${resolvedSegmentCount} 段，正在按单段质量逐段生成...`);

    type RenderedEpisode = {
      episodeIndex: number;
      episodeInput: SeasonPackEpisodeInput;
      result: AnalysisResult;
      promptText: string;
      sourceText: string;
    };

    const renderedEpisodes: Array<RenderedEpisode | undefined> = new Array(resolvedSegmentCount);
    const repairQueue: Array<{ episode: SeasonPackEpisodeResult; reason: string; reasonType: BatchRepairReasonType }> = [];
    const queuedRepairIndexes = new Set<number>();
    const queuedSaveIndexes = new Set<number>();
    let nextSegmentToSave = 1;
    let saveChain = Promise.resolve();
    let saveError: Error | null = null;

    function writeBatchSegmentCache() {
      if (typeof window === "undefined") return;
      try {
        const cachedSegments = renderedEpisodes
          .filter((item): item is RenderedEpisode => Boolean(item))
          .sort((left, right) => left.episodeIndex - right.episodeIndex)
          .map((item) => ({
            episodeIndex: item.episodeIndex,
            title: item.result.title,
            sourceText: item.sourceText,
            promptText: item.promptText,
            result: item.result,
            cachedAt: new Date().toISOString(),
          }));
        window.localStorage.setItem(
          batchCacheKey,
          JSON.stringify({
            batchId: seasonPackJob.id,
            projectId: activeProjectId || null,
            resolvedSegmentCount,
            cachedCount: cachedSegments.length,
            updatedAt: new Date().toISOString(),
            segments: cachedSegments,
          }),
        );
      } catch (cacheError) {
        console.warn("Failed to cache rendered batch segments", cacheError);
      }
    }

    async function renderBatchSegmentWithQualityRepair(
      renderScript: string,
      renderDuration: string,
      episodeIndex: number,
      episodeCount: number,
    ) {
      const rawResult = await requestAnalysisWithContext(
        renderScript,
        renderDuration,
        activeProjectId || undefined,
        undefined,
      );
      const episodeResult = normalizeBatchEpisodeResult(script, episodeIndex, episodeCount, rawResult, renderDuration);
      try {
        assertBatchSegmentQuality(script, episodeIndex, episodeResult, renderDuration);
        return episodeResult;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "当前段未通过质量校验";
        const reasonType = classifyBatchRepairReason(reason);
        const repairLabel = batchRepairReasonLabel(reasonType);
        updateSegmentProgress(episodeIndex, "repairing", `${repairLabel}: ${reason}`);
        publishBatchProgress("repairing", `第 ${episodeIndex} / ${episodeCount} 段正在自动修复：${reason}`);
        const repairScript = buildBatchSegmentRepairScript(renderScript, episodeIndex, episodeCount, reason, episodeResult);
        const repairedRawResult = await requestAnalysisWithContext(
          repairScript,
          renderDuration,
          activeProjectId || undefined,
          undefined,
        );
        const repairedResult = normalizeBatchEpisodeResult(script, episodeIndex, episodeCount, repairedRawResult, renderDuration);
        assertBatchSegmentQuality(script, episodeIndex, repairedResult, renderDuration);
        return repairedResult;
      }
    }

    function queueReadySegmentSaves() {
      while (nextSegmentToSave <= renderedEpisodes.length) {
        const rendered = renderedEpisodes[nextSegmentToSave - 1];
        if (!rendered || queuedSaveIndexes.has(nextSegmentToSave)) break;

        const queuedIndex = nextSegmentToSave;
        queuedSaveIndexes.add(queuedIndex);
        nextSegmentToSave += 1;

        saveChain = saveChain.then(async () => {
          const episodeIndex = rendered.episodeIndex;
          const episodeResult = rendered.result;
          const episodeScript = rendered.sourceText;
          const fullVideoPrompt = rendered.promptText;

          updateSegmentProgress(episodeIndex, "saving", "正在保存到项目");
          publishBatchProgress("saving", `正在保存第 ${episodeIndex} / ${resolvedSegmentCount} 段...`);
          const save = await saveAnalysisProject(episodeScript, episodeResult, fullVideoPrompt, activeProjectId || undefined, undefined);
          if (!save.saved || !save.projectId || !save.versionId) {
            throw new Error(`第 ${episodeIndex} 段已生成，但项目保存失败：${save.reason || "未返回保存结果"}`);
          }

          activeProjectId = save.projectId;
          latestSaveRef.current = save;
          setProjectSave(save);
          setResumeProjectId(save.projectId);
          setResumeVersionId(save.versionId);

          completed.push({
            segment: { index: episodeIndex, text: episodeScript },
            result: episodeResult,
            promptText: fullVideoPrompt,
          });
          setBatchResults([...completed]);
          setResult(episodeResult);
          updateSegmentProgress(episodeIndex, "saved", "已保存");
          publishBatchProgress("saving", `已保存第 ${episodeIndex} / ${resolvedSegmentCount} 段。`);
        }).catch((error) => {
          saveError = error instanceof Error ? error : new Error(String(error));
          throw saveError;
        });
      }
    }

    function storeRenderedEpisode(
      episode: SeasonPackEpisodeResult,
      episodeResult: AnalysisResult,
    ) {
      const episodeIndex = episode.episodeIndex;
      const episodeInput = episode.input;
      if (episodeInput.shotCount > 0 && episodeResult.storyboard.length !== episodeInput.shotCount) {
        throw new Error(`第 ${episodeIndex} 段生成失败：规划要求 ${episodeInput.shotCount} 个镜头，但生成结果为 ${episodeResult.storyboard.length} 个镜头。`);
      }
      const fullVideoPrompt = buildVideoGenerationPromptText(episodeResult);
      const episodeScript = episodeSourceText(script, episodeIndex, resolvedSegmentCount || episodes.length, episodeInput, episodeResult);
      renderedEpisodes[episodeIndex - 1] = {
        episodeIndex,
        episodeInput,
        result: episodeResult,
        promptText: fullVideoPrompt,
        sourceText: episodeScript,
      };
      setBatchResults(
        renderedEpisodes
          .filter((item): item is RenderedEpisode => Boolean(item))
          .sort((left, right) => left.episodeIndex - right.episodeIndex)
          .map((item) => ({
            segment: { index: item.episodeIndex, text: item.sourceText },
            result: item.result,
            promptText: item.promptText,
          })),
      );
      setResult(episodeResult);
      writeBatchSegmentCache();
      updateSegmentProgress(episodeIndex, "cached", "已生成并缓存，等待前序保存");
      publishBatchProgress("rendering", `第 ${episodeIndex} / ${resolvedSegmentCount} 段已生成并缓存，继续处理剩余分段...`);
      queueReadySegmentSaves();
    }

    async function renderSingleEpisodeWithQualityRepair(episode: SeasonPackEpisodeResult) {
      const episodeIndex = episode.episodeIndex;
      const episodeInput = episode.input;
      const renderScript = buildBatchEpisodeRenderScript(episodeInput, resolvedSegmentCount || episodes.length);
      const renderDuration = episodeInput.duration || selectedDurationValue();

      updateSegmentProgress(episodeIndex, "repairing", "正在按单段质量生成修复");
      publishBatchProgress("repairing", `正在按单段质量生成第 ${episodeIndex} / ${resolvedSegmentCount} 段...`);
      const episodeResult = await renderBatchSegmentWithQualityRepair(renderScript, renderDuration, episodeIndex, resolvedSegmentCount || episodes.length);
      storeRenderedEpisode(episode, episodeResult);
    }

    function queueSegmentRepair(episode: SeasonPackEpisodeResult, reason: string) {
      if (renderedEpisodes[episode.episodeIndex - 1] || queuedRepairIndexes.has(episode.episodeIndex)) return;
      queuedRepairIndexes.add(episode.episodeIndex);
      const reasonType = classifyBatchRepairReason(reason);
      const repairLabel = batchRepairReasonLabel(reasonType);
      repairQueue.push({ episode, reason, reasonType });
      updateSegmentProgress(episode.episodeIndex, "repairing", `${repairLabel}: ${reason}`);
    }

    async function runSegmentRepairPool() {
      if (!repairQueue.length) return;
      publishBatchProgress("repairing", `正在并发重修 ${repairQueue.length} 段，最多同时 ${BATCH_SINGLE_RENDER_CONCURRENCY} 段...`);

      let nextRepairIndex = 0;
      const repairConcurrency = Math.min(BATCH_SINGLE_RENDER_CONCURRENCY, repairQueue.length);

      async function repairNextSegment() {
        while (nextRepairIndex < repairQueue.length) {
          const repairIndex = nextRepairIndex;
          nextRepairIndex += 1;
          const { episode, reasonType } = repairQueue[repairIndex];
          updateSegmentProgress(episode.episodeIndex, "repairing", `${batchRepairReasonLabel(reasonType)}: retrying single-segment render`);
          await renderSingleEpisodeWithQualityRepair(episode);
        }
      }

      await Promise.all(Array.from({ length: repairConcurrency }, () => repairNextSegment()));
    }

    async function renderPackedSegmentsWithQualityRepair(packEpisodes: SeasonPackEpisodeResult[], allowSplitFallback = true) {
      const packLabel = packEpisodes.map((episode) => episode.episodeIndex).join(", ");
      const packSegments = packEpisodes.map((episode) => {
        const episodeInput = episode.input;
        return {
          episodeIndex: episode.episodeIndex,
          title: episodeInput.title,
          script: episodeInput.sourceText || script,
          renderInputScript: buildBatchEpisodeRenderScript(episodeInput, resolvedSegmentCount || episodes.length),
          duration: episodeInput.duration || selectedDurationValue(),
          shotCount: episodeInput.shotCount,
        };
      });

      for (const episode of packEpisodes) {
        updateSegmentProgress(episode.episodeIndex, "running", `Render Pack 生成中：${packLabel}`);
      }
      publishBatchProgress("rendering", `正在本地并发生成 Render Pack：第 ${packLabel} 段...`);

      try {
        async function runRenderPack(mode: RenderPackCodexMode) {
          const packJob = await createVideoPromptPackCodexJob(packSegments, activeProjectId || undefined, mode);
          return pollVideoPromptPackCodexJob(packJob.id, packSegments.length);
        }

        let renderPackJob: VideoPromptPackCodexJob;
        try {
          renderPackJob = await runRenderPack(STRICT_UTF8_RENDER_PACK_MODE);
        } catch (strictError) {
          if (allowSplitFallback && packEpisodes.length > 2 && isRecoverableRenderPackError(strictError)) {
            const splitAt = Math.ceil(packEpisodes.length / 2);
            const splitRenderPacks = [packEpisodes.slice(0, splitAt), packEpisodes.slice(splitAt)].filter((pack) => pack.length);
            const reason = strictError instanceof Error ? strictError.message : "Render Pack strict UTF-8 generation failed";
            publishBatchProgress(
              "repairing",
              `Render Pack 第 ${packLabel} 段 strict UTF-8 失败，正在拆成 ${splitRenderPacks.length} 个小包继续生成：${reason}`,
            );
            await Promise.all(splitRenderPacks.map((splitPack) => renderPackedSegmentsWithQualityRepair(splitPack, false)));
            return;
          }
          throw strictError;
        }
        const packDurationMs = renderPackDurationMs(renderPackJob);
        if (packDurationMs >= SLOW_RENDER_PACK_WARNING_MS) {
          const minutes = Math.round(packDurationMs / 60_000);
          publishBatchProgress("rendering", `Render Pack ${packLabel} took ${minutes} minutes, marked as slow pack for diagnostics.`);
        }

        const packResults = new Map(
          (renderPackJob.result?.segments || []).map((segment) => [segment.episodeIndex, segment.result] as const),
        );

        for (const episode of packEpisodes) {
          const episodeIndex = episode.episodeIndex;
          const episodeInput = episode.input;
          const renderDuration = episodeInput.duration || selectedDurationValue();
          const rawResult = packResults.get(episodeIndex);
          if (!rawResult) {
            queueSegmentRepair(episode, "Render Pack 缺少本段结果，转为单段修复");
            continue;
          }
          const episodeResult = normalizeBatchEpisodeResult(script, episodeIndex, resolvedSegmentCount || episodes.length, rawResult, renderDuration);
          try {
            assertBatchSegmentQuality(script, episodeIndex, episodeResult, renderDuration);
            storeRenderedEpisode(episode, episodeResult);
          } catch (error) {
            const reason = error instanceof Error ? error.message : "Render Pack 结果未通过单段质量校验";
            publishBatchProgress("repairing", `第 ${episodeIndex} / ${resolvedSegmentCount} 段 Render Pack 未过质量闸，正在单段重修：${reason}`);
            queueSegmentRepair(episode, reason);
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Render Pack 生成失败";
        publishBatchProgress("repairing", `Render Pack 第 ${packLabel} 段失败，正在逐段降级修复：${reason}`);
        for (const episode of packEpisodes) {
          queueSegmentRepair(episode, reason);
        }
      }
    }

    const renderPacks = chunkEpisodesForRenderPacks(episodes, BATCH_RENDER_PACK_SIZE);
    let nextPackToRender = 0;
    const renderPackConcurrency = Math.min(BATCH_RENDER_PACK_CONCURRENCY, renderPacks.length);

    async function renderNextPack() {
      while (nextPackToRender < renderPacks.length) {
        const packIndex = nextPackToRender;
        nextPackToRender += 1;
        await renderPackedSegmentsWithQualityRepair(renderPacks[packIndex]);
      }
    }

    await Promise.all(Array.from({ length: renderPackConcurrency }, () => renderNextPack()));
    await runSegmentRepairPool();

    for (const rendered of renderedEpisodes) {
      if (!rendered) {
        throw new Error("有分段未完成单段质量生成，请重新生成。");
      }
    }
    queueReadySegmentSaves();
    await saveChain;
    if (saveError) throw saveError;

    if (latestSaveRef.current?.versionId) {
      setResumeVersionId(latestSaveRef.current.versionId);
      creatingNewEpisodeRef.current = false;
      setCreatingNewEpisode(false);
    }
    publishBatchProgress("completed", `已生成 ${completed.length} 段，并按顺序保存到同一个项目。`);
  }

  async function handlePromptFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setUploadingText(true);
    setError("");
    setResult(null);
    setProjectSave(null);
    setBatchResults([]);
    setBatchProgress(null);
    setGenerationProgress("正在读取文案...");

    try {
      const ext = file.name.toLowerCase().split(".").pop();
      let text = "";

      if (ext === "txt") {
        text = await file.text();
      } else {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/extract-text", { method: "POST", body: formData });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        text = data.text;
      }

      const cleanText = text.replace(/\r\n?/g, "\n").trim();
      if (!cleanText) throw new Error("没有从文件中读取到正文");
      setScript(cleanText);
      setUploadedFileName(file.name);
      setGenerationProgress(`已导入 ${file.name}，约 ${cleanText.length} 字。生成时会按当前段数和时长设置处理。`);
    } catch (err: any) {
      setError(formatUserFacingError(err?.message, "文案文件读取失败"));
      setGenerationProgress("");
    } finally {
      setUploadingText(false);
    }
  }

  async function analyze() {
    setLoading(true);
    setError("");
    setImageError("");
    setPromptSafetyError("");
    setPromptSafetyMessage("");
    setStoryboardImage(null);
    setSelectedShot(null);
    setReferenceShot(null);
    setSelectedLibraryItem(null);
    setProjectSave(null);
    setDurationPickerOpen(false);
    setEpisodeCountPickerOpen(false);
    setBatchResults([]);
    setBatchProgress(null);

    try {
      if (segmentCountMode === "auto" || episodeCount > 1) {
        await runBatchEpisodeGeneration();
        return;
      }

      setGenerationProgress("正在生成...");
      const singleResult = await requestAnalysis(script, selectedDurationValue());
      const fullVideoPrompt = buildVideoGenerationPromptText(singleResult);
      const save = await saveAnalysisProject(script, singleResult, fullVideoPrompt);
      setProjectSave(save);
      if (save.projectId) setResumeProjectId(save.projectId);
      if (save.versionId) {
        setResumeVersionId(save.versionId);
        creatingNewEpisodeRef.current = false;
        setCreatingNewEpisode(false);
      }
      setResult(singleResult);
      setGenerationProgress("生成完成。");
    } catch (err: any) {
      const message = err?.message === "Failed to fetch"
        ? "本地服务暂时无响应，请确认开发服务器正在运行，或重启后再试。"
        : formatUserFacingError(err, "分析失败");
      setError(message);
    } finally {
      setLoading(false);
      setBatchGenerating(false);
    }
  }

  async function downloadPromptDocx() {
    const sections = batchResults.length
      ? batchResults.map((item) => ({
          heading: `第 ${item.segment.index} 段｜${item.result.title}｜${item.result.duration}`,
          originalText: item.segment.text,
          promptText: item.promptText,
        }))
      : result
        ? [{
            heading: `${result.title}｜${result.duration}`,
            originalText: script,
            promptText: buildVideoGenerationPromptText(result),
          }]
        : [];

    if (!sections.length) return;

    const res = await fetch("/api/prompt-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: uploadedFileName ? `${uploadedFileName} 视频提示词` : "AI 视频提示词",
        sections,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error || "DOCX 下载失败");
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = uploadedFileName ? `${uploadedFileName.replace(/\.[^.]+$/, "")}-视频提示词.docx` : "AI视频提示词.docx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function saveStoryboardImageReference(storyboardImageUrl: string, storyboardImagePrompt?: string) {
    if (!projectSave?.saved || !projectSave.projectId || !projectSave.versionId) return "";

    const res = await fetch("/api/projects/storyboard-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectSave.projectId,
        versionId: projectSave.versionId,
        storyboardImageUrl,
        storyboardImagePrompt,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "分镜图保存失败");
    return typeof data.storyboardImageUrl === "string" ? data.storyboardImageUrl : "";
  }

  function storyboardCodexPanels(job: StoryboardCodexJob) {
    return Object.fromEntries(
      job.panels
        .filter((panel) => typeof panel.imageUrl === "string" && panel.imageUrl.length > 0)
        .map((panel) => [panel.shotNumber, panel.imageUrl as string]),
    ) as Record<number, string>;
  }

  function updateStoryboardImageFromCodexJob(job: StoryboardCodexJob) {
    const panels = storyboardCodexPanels(job);
    if (!Object.keys(panels).length && !job.sheetUrl) return;
    setStoryboardImage({
      sheetUrl: job.sheetUrl || "",
      prompt: job.prompt || "",
      panels,
    });
  }

  async function saveStoryboardVisualAssets(job: StoryboardCodexJob) {
    if (!projectSave?.saved || !projectSave.projectId || !projectSave.versionId) return [];

    const visualAssets = job.panels
      .filter((panel) => panel.status === "completed" && typeof panel.imageUrl === "string" && panel.imageUrl.length > 0)
      .map((panel) => ({
        type: "SHOT_STORYBOARD",
        name: `镜头 ${panel.shotNumber} 分镜图`,
        shotNumber: panel.shotNumber,
        prompt: panel.prompt || job.prompt || "",
        imageUrl: panel.imageUrl,
        status: "COMPLETED",
        metadata: {
          source: "codex-imagegen",
          jobId: job.id,
          panelId: panel.id,
          batchIndex: panel.batchIndex,
          batchTotal: panel.batchTotal,
          size: panel.size,
          quality: panel.quality,
          attempts: panel.attempts,
          sourceImagePath: panel.sourceImagePath,
          outputHash: panel.outputHash,
          imageFingerprint: panel.imageFingerprint,
          codexLogPath: panel.codexLogPath,
          duplicateOfPanelId: panel.duplicateOfPanelId,
        },
      }));

    if (!visualAssets.length) return [];

    const res = await fetch("/api/projects/visual-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectSave.projectId,
        versionId: projectSave.versionId,
        visualAssets,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "镜头资产保存失败");
    return data.save?.visualAssets || [];
  }

  async function createStoryboardCodexJob(storyboardResult: AnalysisResult) {
    if (!projectSave?.projectId || !projectSave.versionId) {
      throw new Error("请先登录并等待项目保存完成后，再生成镜头分镜图。");
    }

    const res = await fetch("/api/storyboard-image/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectSave.projectId,
        versionId: projectSave.versionId,
        title: storyboardResult.title,
        style: `${storyboardResult.style}，16:9 彩色电影级分镜图，电影光影，写实概念美术`,
        storyboard: storyboardResult.storyboard,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Codex 分镜图任务创建失败");
    return data.job as StoryboardCodexJob;
  }

  async function pollStoryboardCodexJob(jobId: string) {
    const startedAt = Date.now();
    let timeoutMs = 30 * 60_000;
    const pollMs = 2500;

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/storyboard-image/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Codex 分镜图任务查询失败");

      const job = data.job as StoryboardCodexJob;
      timeoutMs = calculateStoryboardCodexTimeoutMs(job);
      const completed = job.panels.filter((panel) => panel.status === "completed").length;
      const running = job.panels.filter((panel) => panel.status === "running").length;
      updateStoryboardImageFromCodexJob(job);
      setGenerationProgress(
        running
          ? `镜头分镜图生成中：${completed}/${job.panels.length} 已完成，${running} 张处理中。`
          : `镜头分镜图排队中：${completed}/${job.panels.length} 已完成。`,
      );

      if (job.status === "completed") return job;
      if (job.status === "failed") throw new Error(job.error || "Codex 分镜图任务失败");
      await new Promise((resolve) => window.setTimeout(resolve, pollMs));
    }

    throw new Error("Codex 分镜图任务等待超时，请确认 storyboard:codex-worker 正在运行。");
  }

  async function generateStoryboardImage() {
    if (!result) return;

    setImageLoading(true);
    setImageError("");
    setStoryboardImage(null);

    try {
      if (!projectSave?.saved || !projectSave.projectId || !projectSave.versionId) {
        throw new Error("请先完成本次生成并保存项目后，再生成镜头分镜图。镜头分镜图会保存为项目 VisualAsset。");
      }

      const job = await createStoryboardCodexJob(result);
      updateStoryboardImageFromCodexJob(job);
      setGenerationProgress(`已创建 Codex 分镜图任务，共 ${job.panels.length} 张。请确认 storyboard:codex-worker 正在运行。`);
      const completedJob = await pollStoryboardCodexJob(job.id);
      const panels = storyboardCodexPanels(completedJob);
      if (!Object.keys(panels).length) throw new Error("Codex 分镜图任务完成但没有生成镜头图片");
      await saveStoryboardVisualAssets(completedJob);
      setStoryboardImage({
        sheetUrl: "",
        prompt: completedJob.prompt || "",
        panels,
      });
      setGenerationProgress("镜头分镜图生成完成，已保存到镜头资产。");
    } catch (err: any) {
      setImageError(formatUserFacingError(err, "镜头分镜图生成失败"));
    } finally {
      setImageLoading(false);
    }
  }

  const selectedImage = selectedShot ? storyboardImage?.panels[selectedShot.shotNumber] : "";
  const referenceMatches: ShotReferenceMatches = referenceShot
    ? matchShotReferences(referenceShot, libraryItems)
    : { shot: [], camera: [], transition: [] };
  const referenceTotal = referenceMatches.shot.length + referenceMatches.camera.length + referenceMatches.transition.length;

  return (
    <div className="space-y-6">
      <section className="workspace-hero-shell relative isolate flex min-h-[calc(100vh-7rem)] w-full flex-col items-center justify-center overflow-visible px-4 py-12 md:py-16">
        <div className="workspace-orb-field fixed inset-0 -z-10" aria-hidden="true">
          {workspaceParticles.map((particle, index) => (
            <span key={index} className="workspace-particle" style={particleStyle(particle)} />
          ))}
        </div>

        <div className="mb-9 flex items-center justify-center gap-4">
          <span className="title-planet" aria-hidden="true">
            <span className="title-planet-ring" />
            <span className="title-planet-core" />
            <span className="title-star title-star-one" />
            <span className="title-star title-star-two" />
            <span className="title-star title-star-three" />
          </span>
          <h1 className="bg-gradient-to-r from-violet-200 via-fuchsia-300 to-cyan-200 bg-clip-text text-center text-4xl font-black leading-tight text-transparent md:text-6xl">
            超创视频工作站
          </h1>
        </div>

        <div className="workspace-prompt-card w-full max-w-5xl">
          <div className="workspace-prompt-inner">
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              className="min-h-48 w-full resize-none rounded-t-[1.25rem] border-0 bg-transparent px-7 py-7 text-base font-semibold leading-8 text-slate-100 outline-none placeholder:text-slate-500 md:min-h-60 md:px-8"
              placeholder="未来城市的夜晚，霓虹灯闪烁，飞行汽车穿梭在高楼之间..."
            />
            <div className="workspace-prompt-toolbar flex flex-wrap items-center gap-3 rounded-b-[1.25rem] border-t border-white/[0.08] px-5 py-4 md:px-6">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.docx"
                className="hidden"
                onChange={handlePromptFileUpload}
              />
              <button
                className="prompt-tool-icon"
                aria-label="导入文案"
                title="导入 txt / docx 文案"
                type="button"
                disabled={uploadingText || loading || batchGenerating}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadingText ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              </button>
              <span className="h-6 w-px bg-white/10" />
              <span className="prompt-mode-pill">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                短剧 / 通用
              </span>
              <span className="relative inline-flex">
                <button
                  type="button"
                  className="prompt-duration-pill"
                  aria-label="视频时长"
                  aria-expanded={durationPickerOpen}
                  onClick={() => setDurationPickerOpen((open) => !open)}
                >
                  <Clock className="h-3.5 w-3.5" />
                  {durationMode === "auto" ? "自动" : `${durationSeconds}s`}
                </button>
                {durationPickerOpen && (
                  <div className="duration-popover" role="dialog" aria-label="选择视频时长">
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <span className="text-sm font-semibold text-slate-300">视频时长</span>
                      <span className="text-sm font-bold text-slate-200">{durationMode === "auto" ? "自动" : `${durationSeconds}s`}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                          durationMode === "auto"
                            ? "border-cyan-200/60 bg-cyan-300/16 text-cyan-50"
                            : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-100"
                        }`}
                        onClick={() => setDurationMode("auto")}
                      >
                        自动
                      </button>
                      <button
                        type="button"
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                          durationMode === "fixed"
                            ? "border-cyan-200/60 bg-cyan-300/16 text-cyan-50"
                            : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-100"
                        }`}
                        onClick={() => setDurationMode("fixed")}
                      >
                        手动 {durationSeconds}s
                      </button>
                    </div>
                    <p className="mt-3 text-[11px] leading-5 text-slate-500">
                      自动模式会优先读取文案里的总时长，没有写时长时由系统按内容密度判断。
                    </p>
                    <input
                      type="range"
                      min="4"
                      max="15"
                      step="1"
                      value={durationSeconds}
                      disabled={durationMode === "auto"}
                      onChange={(e) => {
                        setDurationMode("fixed");
                        setDurationSeconds(Number(e.target.value));
                      }}
                      className={`duration-slider mt-3 ${durationMode === "auto" ? "opacity-45" : ""}`}
                    />
                    <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                      <span>4s</span>
                      <span>15s</span>
                    </div>
                  </div>
                )}
              </span>
              <span className="relative inline-flex">
                <button
                  type="button"
                  className="prompt-duration-pill"
                  aria-label="生成段数"
                  aria-expanded={episodeCountPickerOpen}
                  disabled={uploadingText || loading || batchGenerating}
                  onClick={() => setEpisodeCountPickerOpen((open) => !open)}
                >
                  <Film className="h-3.5 w-3.5" />
                  {segmentCountMode === "auto" ? "自动" : `${episodeCount} 段`}
                </button>
                {episodeCountPickerOpen && (
                  <div className="duration-popover" role="dialog" aria-label="选择生成段数">
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <span className="text-sm font-semibold text-slate-300">生成段数</span>
                      <span className="text-sm font-bold text-slate-200">{segmentCountMode === "auto" ? "自动" : `${episodeCount} 段`}</span>
                    </div>
                    <button
                      type="button"
                      className={`mb-2 w-full rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                        segmentCountMode === "auto"
                          ? "border-cyan-200/60 bg-cyan-300/16 text-cyan-50"
                          : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-100"
                      }`}
                      onClick={() => setSegmentCountMode("auto")}
                    >
                      自动判断段数
                    </button>
                    <div className="grid grid-cols-5 gap-2">
                      {[1, 3, 5, 10, 30].map((count) => (
                        <button
                          key={count}
                          type="button"
                          className={`rounded-lg border px-2 py-2 text-xs font-semibold transition ${
                            segmentCountMode === "fixed" && episodeCount === count
                              ? "border-cyan-200/60 bg-cyan-300/16 text-cyan-50"
                              : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-100"
                          }`}
                          onClick={() => updateEpisodeCount(count)}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                    <p className="mt-3 text-[11px] leading-5 text-slate-500">
                      自动模式会先分析小说章节或原文结构，识别适合的段数；固定模式会严格按你选择的段数生成。每段默认不超过 15 秒。
                    </p>
                    <input
                      type="range"
                      min="1"
                      max="30"
                      step="1"
                      value={episodeCount}
                      disabled={segmentCountMode === "auto"}
                      onChange={(e) => updateEpisodeCount(Number(e.target.value))}
                      className={`duration-slider mt-3 ${segmentCountMode === "auto" ? "opacity-45" : ""}`}
                    />
                    <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                      <span>1 段</span>
                      <span>30 段</span>
                    </div>
                  </div>
                )}
              </span>
              <span className="ml-auto text-xs text-slate-500">{script.length}/50000</span>
              <button
                onClick={analyze}
                disabled={loading || uploadingText || batchGenerating}
                className="prompt-send-button"
                aria-label={loading ? "正在生成" : "生成视频提示词"}
                title={loading ? "正在生成" : "生成视频提示词"}
              >
                {loading || batchGenerating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>

        {(uploadingText || loading || batchGenerating || generationProgress) && (
          <div className="mt-4 flex w-full max-w-5xl items-center gap-3 rounded-xl border border-violet-300/18 bg-violet-500/10 px-4 py-3 text-sm text-violet-50">
            {(uploadingText || loading || batchGenerating) && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{generationProgress || "正在生成..."}</span>
          </div>
        )}
        {batchProgress && (
          <div className="mt-4 w-full max-w-5xl rounded-xl border border-cyan-300/18 bg-slate-950/70 p-4 text-sm text-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-cyan-200/70">Segment Batch Progress</div>
                <div className="mt-1 font-semibold text-white">{batchProgress.currentMessage}</div>
              </div>
              <div className="text-xs text-slate-400">
                {batchProgress.mode === "auto" ? "自动分段" : `固定 ${batchProgress.requestedCount || episodeCount} 段`}
                {batchProgress.resolvedSegmentCount ? ` · 已识别 ${batchProgress.resolvedSegmentCount} 段` : ""}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300 md:grid-cols-5">
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">完成 {batchProgress.completedCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">生成中 {batchProgress.runningCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">修复 {batchProgress.repairingCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">保存 {batchProgress.savingCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">等待 {batchProgress.pendingCount}</span>
            </div>
            {batchProgress.segments.length > 0 && (
              <div className="mt-3 flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
                {batchProgress.segments.map((segment) => (
                  <span
                    key={segment.index}
                    title={segment.message || segment.title || ""}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${
                      segment.status === "saved" || segment.status === "completed"
                        ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-50"
                        : segment.status === "running" || segment.status === "saving"
                          ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-50"
                          : segment.status === "repairing"
                            ? "border-amber-300/20 bg-amber-300/10 text-amber-50"
                            : segment.status === "failed"
                              ? "border-red-300/20 bg-red-300/10 text-red-50"
                              : "border-white/10 bg-white/[0.03] text-slate-400"
                    }`}
                  >
                    第 {segment.index} 段 · {segment.status}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <p className="mt-4 w-full max-w-5xl rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{error}</p>}
      </section>
      {result && (
        <section className="glass-panel rounded-2xl p-5 md:p-6">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 text-xs uppercase text-cyan-200/70">
                <ScanLine className="h-3.5 w-3.5" /> AI Video Prompt Skill
              </div>
              <h2 className="text-2xl font-bold text-white">{result.title}</h2>
              <p className="mt-1 text-sm text-slate-500">系统已根据文案自动设计题材、风格、总时长和镜头节奏</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={generateStoryboardImage}
                disabled={imageLoading}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/18 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-300/16 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {imageLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                {imageLoading ? "正在生成镜头分镜图..." : "生成镜头分镜图"}
              </button>
              <button
                onClick={downloadPromptDocx}
                disabled={!result && !batchResults.length}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/18 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-300/16 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                下载 DOCX
              </button>
              <button
                onClick={runSeedancePromptSafetyOptimization}
                disabled={promptSafetyLoading || !result}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-300/16 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {promptSafetyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {promptSafetyLoading ? "正在合规优化" : "Seedance 合规优化"}
              </button>
              <CopyButton text={JSON.stringify(result, null, 2)} label="复制全部 JSON" />
            </div>
          </div>

          {imageError && <p className="mb-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{imageError}</p>}
          {(promptSafetyMessage || promptSafetyError) && (
            <p
              className={`mb-4 rounded-xl border p-3 text-sm ${
                promptSafetyError
                  ? "border-red-400/20 bg-red-500/10 text-red-100"
                  : "border-emerald-300/18 bg-emerald-400/10 text-emerald-50"
              }`}
            >
              {promptSafetyError || promptSafetyMessage}
            </p>
          )}

          {Boolean(batchResults.length) && (
            <div className="mb-6 rounded-2xl border border-violet-300/16 bg-violet-500/8 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-white">批量分段生成</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    已生成 {batchResults.length} 段，并按顺序保存到同一个项目。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
                    {batchResults.map((item) => (
                      <span key={item.segment.index} className="rounded-lg border border-violet-200/18 bg-violet-300/10 px-2.5 py-1">
                        第 {item.segment.index} 段
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={downloadPromptDocx}
                  className="inline-flex items-center gap-2 rounded-xl border border-violet-200/24 bg-violet-400/16 px-4 py-2 text-sm font-semibold text-violet-50 transition hover:bg-violet-400/24"
                >
                  <Download className="h-4 w-4" />
                  下载 DOCX
                </button>
              </div>
            </div>
          )}

          {(result.usedKnowledge?.length || result.agentTrace?.length) && (
            <div className="mb-6 grid gap-4 lg:grid-cols-2">
              {Boolean(result.usedKnowledge?.length) && (
                <div className="rounded-2xl border border-cyan-300/12 bg-slate-950/55 p-4">
                  <h3 className="mb-3 text-sm font-bold text-cyan-100">LangGraph 本次命中的知识库</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.usedKnowledge?.map((item) => (
                      <span key={item.id} className="rounded-full border border-cyan-300/16 bg-cyan-300/8 px-3 py-1 text-xs text-cyan-50">
                        {item.name} · {Math.round(item.score)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {Boolean(result.agentTrace?.length) && (
                <div className="rounded-2xl border border-cyan-300/12 bg-slate-950/55 p-4">
                  <h3 className="mb-3 text-sm font-bold text-cyan-100">Agent 执行轨迹</h3>
                  <div className="space-y-2 text-xs text-slate-300">
                    {result.agentTrace?.map((step, index) => (
                      <div key={`${step.step}-${index}`} className="flex gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
                        <span className="text-cyan-200">{index + 1}.</span>
                        <span>{step.detail}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mb-6">
            <ResultTextBlock title="视频生成提示词" text={buildVideoGenerationPromptText(result)} copyLabel="复制视频生成提示词" />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-cyan-300/12">
            <table className="w-full min-w-[1760px] border-collapse text-left text-sm">
              <thead className="bg-cyan-300/[0.06] text-xs uppercase text-cyan-100/70">
                <tr>
                  <th className="p-4">镜头</th>
                  <th className="p-4">时间</th>
                  <th className="p-4">画面</th>
                  <th className="p-4">镜头分镜图</th>
                  <th className="p-4">景别</th>
                  <th className="p-4">机位/构图</th>
                  <th className="p-4">运镜</th>
                  <th className="p-4">光影/色调</th>
                  <th className="p-4">声音/台词</th>
                  <th className="p-4">情绪</th>
                  <th className="p-4">转场</th>
                  <th className="p-4">镜头目的</th>
                  <th className="p-4">参考镜头</th>
                  <th className="p-4">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.storyboard.map((shot) => {
                  const panelImage = storyboardImage?.panels[shot.shotNumber];
                  return (
                    <tr key={shot.shotNumber} className="border-t border-cyan-300/10 align-top text-slate-300">
                      <td className="p-4 font-bold text-cyan-200">{shot.shotNumber}</td>
                      <td className="p-4 text-slate-400">{shot.timeRange || "-"}</td>
                      <td className="max-w-[360px] p-4">{shot.visual}</td>
                      <td className="w-56 p-4">
                        {panelImage ? (
                          <button
                            onClick={() => setSelectedShot(shot)}
                            className="group block w-52 overflow-hidden rounded-xl border border-cyan-300/16 bg-slate-950 text-left transition hover:border-cyan-200/45"
                          >
                            <img src={panelImage} alt={`镜头 ${shot.shotNumber} 分镜图`} className="aspect-video w-full object-cover" />
                            <span className="flex items-center justify-between px-3 py-2 text-xs font-semibold text-cyan-100">
                              查看分镜图 <Maximize2 className="h-3.5 w-3.5 opacity-70 group-hover:opacity-100" />
                            </span>
                          </button>
                        ) : (
                          <span className="inline-flex w-52 items-center justify-center rounded-xl border border-dashed border-cyan-300/18 bg-slate-950/60 px-3 py-8 text-center text-xs text-slate-500">
                            生成后显示
                          </span>
                        )}
                      </td>
                      <td className="p-4 text-slate-400">{shot.shotType}</td>
                      <td className="p-4 text-slate-400">{shot.composition || "-"}</td>
                      <td className="p-4 text-slate-400">{shot.cameraMovement}</td>
                      <td className="p-4 text-slate-400">{shot.lighting || "-"}</td>
                      <td className="max-w-[260px] p-4 text-slate-400">
                        <div>{shot.sound || "-"}</div>
                        {shot.dialogue && <div className="mt-2 text-slate-500">台词：{shot.dialogue}</div>}
                      </td>
                      <td className="p-4 text-slate-400">{shot.emotion}</td>
                      <td className="p-4 text-slate-400">{shot.transition}</td>
                      <td className="p-4 text-slate-400">{shot.shotPurpose || "-"}</td>
                      <td className="p-4">
                        <button
                          onClick={() => setReferenceShot(shot)}
                          className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/18 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-300/16"
                        >
                          <Film className="h-4 w-4" />
                          参考镜头
                        </button>
                      </td>
                      <td className="p-4"><CopyButton text={shot.videoPrompt} label="复制提示词" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

        </section>
      )}

      {referenceShot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm" onClick={() => setReferenceShot(null)}>
          <div className="max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-cyan-300/20 bg-slate-950 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-cyan-300/12 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-200/70">Reference Motion</p>
                <h3 className="text-lg font-bold text-white">镜头 {referenceShot.shotNumber} 的参考镜头 / 运镜 / 转场</h3>
                <p className="mt-1 text-sm text-slate-500">点击任意参考项，打开右侧详情抽屉。</p>
              </div>
              <button onClick={() => setReferenceShot(null)} className="rounded-xl border border-white/10 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[calc(92vh-98px)] space-y-6 overflow-y-auto p-5">
              {libraryError && <div className="rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{libraryError}</div>}
              {!libraryError && referenceTotal === 0 && (
                <div className="rounded-xl border border-dashed border-cyan-300/16 bg-slate-950/60 p-4 text-sm text-slate-500">
                  暂无匹配参考。你可以在后台上传同名镜头、运镜或转场，之后这里会自动显示。
                </div>
              )}
              <ReferenceSection title="镜头参考" items={referenceMatches.shot} emptyText="暂无匹配镜头参考" onSelect={setSelectedLibraryItem} />
              <ReferenceSection title="运镜参考" items={referenceMatches.camera} emptyText="暂无匹配运镜参考" onSelect={setSelectedLibraryItem} />
              <ReferenceSection title="转场参考" items={referenceMatches.transition} emptyText="暂无匹配转场参考" onSelect={setSelectedLibraryItem} />
            </div>
          </div>
        </div>
      )}

      {selectedShot && selectedImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/78 p-4 backdrop-blur-sm" onClick={() => setSelectedShot(null)}>
          <div className="max-h-[92vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-cyan-300/20 bg-slate-950 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-cyan-300/12 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-200/70">Storyboard Preview</p>
                <h3 className="text-lg font-bold text-white">镜头 {selectedShot.shotNumber}</h3>
              </div>
              <button onClick={() => setSelectedShot(null)} className="rounded-xl border border-white/10 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid max-h-[calc(92vh-78px)] gap-0 overflow-auto lg:grid-cols-[1.25fr_0.75fr]">
              <div className="bg-black/35 p-4">
                <img src={selectedImage} alt={`镜头 ${selectedShot.shotNumber} 放大分镜图`} className="mx-auto w-full rounded-xl border border-white/10" />
              </div>
              <div className="space-y-4 border-t border-cyan-300/12 p-5 lg:border-l lg:border-t-0">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl border border-cyan-300/12 bg-cyan-300/[0.04] p-3">
                    <div className="text-xs text-cyan-200/70">时间段</div>
                    <div className="mt-1 text-slate-200">{selectedShot.timeRange || "-"}</div>
                  </div>
                  <div className="rounded-xl border border-cyan-300/12 bg-cyan-300/[0.04] p-3">
                    <div className="text-xs text-cyan-200/70">景别</div>
                    <div className="mt-1 text-slate-200">{selectedShot.shotType}</div>
                  </div>
                  <div className="rounded-xl border border-cyan-300/12 bg-cyan-300/[0.04] p-3">
                    <div className="text-xs text-cyan-200/70">机位/构图</div>
                    <div className="mt-1 text-slate-200">{selectedShot.composition || "-"}</div>
                  </div>
                  <div className="rounded-xl border border-cyan-300/12 bg-cyan-300/[0.04] p-3">
                    <div className="text-xs text-cyan-200/70">运镜/转场</div>
                    <div className="mt-1 text-slate-200">{selectedShot.cameraMovement} / {selectedShot.transition}</div>
                  </div>
                </div>
                <div>
                  <h4 className="mb-2 font-bold text-white">画面词</h4>
                  <p className="text-sm leading-7 text-slate-300">{selectedShot.visual}</p>
                </div>
                <div>
                  <h4 className="mb-2 font-bold text-white">光影 / 声音 / 台词</h4>
                  <p className="text-sm leading-7 text-slate-300">
                    光影：{selectedShot.lighting || "-"}<br />
                    声音：{selectedShot.sound || "-"}<br />
                    台词：{selectedShot.dialogue || "无"}
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 font-bold text-white">镜头目的</h4>
                  <p className="text-sm leading-7 text-slate-300">{selectedShot.shotPurpose || "-"}</p>
                </div>
                <div>
                  <h4 className="mb-2 font-bold text-white">首帧 / 尾帧提示词</h4>
                  <p className="text-sm leading-7 text-slate-300">
                    首帧：{selectedShot.firstFramePrompt}<br />
                    尾帧：{selectedShot.lastFramePrompt}
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 font-bold text-white">视频提示词</h4>
                  <p className="text-sm leading-7 text-slate-300">{selectedShot.videoPrompt}</p>
                </div>
                <div>
                  <h4 className="mb-2 font-bold text-white">负面提示词</h4>
                  <p className="text-sm leading-7 text-slate-400">{selectedShot.negativePrompt}</p>
                </div>
                <CopyButton text={selectedShot.videoPrompt} label="复制本镜头提示词" />
              </div>
            </div>
          </div>
        </div>
      )}

      <Drawer item={selectedLibraryItem} onClose={() => setSelectedLibraryItem(null)} />
    </div>
  );
}
