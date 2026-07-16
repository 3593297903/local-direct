"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { AnalysisResult, KnowledgeItem, StoryboardShot } from "@/types";
import { CopyButton } from "@/components/CopyButton";
import { Drawer } from "@/components/Drawer";
import { PreviewAnimation } from "@/components/PreviewAnimation";
import { matchShotReferences, ShotReferenceMatches } from "@/lib/reference-matcher";
import { DEFAULT_COVERAGE_POLICY_VERSION, type SegmentContract } from "@/lib/batch-segment-contract";
import {
  coverageStageInvokesJudge,
  coverageStageUsesLocalGate,
  type BatchEventFeatureSnapshot,
} from "@/lib/batch-event-feature-flags";
import { applyPromptSafetyPolicyDeep } from "@/lib/prompt-safety-policy";
import { buildRenderPacks } from "@/lib/batch-render-scheduler";
import {
  collectContiguousBatchSaveIndexes,
  createInitialSegmentStates,
  createResumableBatchSaveController,
  deriveBatchPhaseFromSegmentStates,
  progressStatusFromSegmentState,
  reduceSegmentState,
  resolveBatchGenerationPhase,
  summarizeBatchSegmentProgress,
  type BatchSegmentProgressStatus,
  type ResumableBatchSaveResult,
  type SegmentStateEvent,
  type SegmentStateRecord,
} from "@/lib/batch-segment-progress";
import {
  createBatchInvocationLedger,
  createBatchRepairScheduler,
  decideLateRepairMerge,
  shouldContinueDetachedRepairObservation,
  type BatchInvocationLedgerEvent,
  REPAIR_FRONTEND_WAIT_TIMEOUT_MS,
} from "@/lib/batch-repair-scheduler";
import {
  SEGMENT_BATCH_RECOVERY_REGISTRY_KEY,
  buildSegmentBatchLeaseOwnerKey,
  buildSegmentBatchRecoveryKey,
  buildSegmentBatchRecoveryKeys,
  buildStableBatchContractHash,
  parseSegmentBatchRecoveryRegistry,
  removeSegmentBatchRecoveryPointer,
  upsertSegmentBatchRecoveryPointer,
  type SegmentBatchRecoveryPointer,
} from "@/lib/segment-batch-cache-identity";
import type { SegmentBatchCacheDocumentV2 } from "@/lib/segment-batch-cache";
import {
  attachRenderOperationJob,
  createRenderOperationDraft,
  detachRenderOperation,
  retainBoundedRenderOperationAudits,
  terminateRenderOperation,
  type RenderOperationRefV2,
} from "@/lib/batch-render-operation";
import {
  applyPreparedRenderPackReconciliation,
  createRenderPackObserverRegistry,
  hasActiveRenderRecovery,
  hasSaveableUnsavedResults,
  isBatchRenderLateReconciliationEnabled,
  listRecoverableRenderOperations,
  observeRenderPackJob,
  prepareRenderPackReconciliation,
  reconcileDetachedRenderPack,
  retryCreatingRenderOperation,
  startConcurrentRenderRecoveryObservers,
  type RenderObservationOutcome,
} from "@/lib/batch-render-reconciliation";
import {
  findInternalPromptToken,
  sanitizeInternalPromptTokens,
  sanitizeInternalPromptTokensDeep,
} from "@/lib/internal-prompt-token-sanitizer";
import {
  createSegmentQualityReport,
  segmentQualityReportStatusFromState,
  summarizeSegmentQualityReports,
  updateSegmentQualityReportStatus,
  type BatchQualityReportSummary,
  type SegmentQualityReport,
  type SegmentQualityStatus,
} from "@/lib/batch-segment-quality-report";
import {
  applyDeterministicQualityPatchWithDiff,
  buildTargetedRepairReason,
  evaluateBatchSegmentQuality,
  selectDeterministicQualityPatchFindings,
  shouldRepairWithCodex,
  summarizeQualityFindings,
  type BatchSegmentQualityGate,
  type BatchSegmentQualityFinding,
  type QualityPatchDiff,
} from "@/lib/batch-segment-quality-gate";
import {
  applyBatchSegmentRepairPatch,
  assertBatchSegmentRepairPatchIsolation,
  buildBatchSegmentResultHash,
  getBatchSegmentRepairValueAtPath,
  isAllowedBatchSegmentRepairPath,
  normalizeBatchSegmentRepairPath,
  type BatchSegmentRepairPatchResult,
} from "@/lib/batch-segment-repair-patch";
import {
  collectEventCoverageInspectedFields,
  validateSegmentEventCoverage,
  type CoverageDecision,
  type SegmentCoverageSidecar,
} from "@/lib/batch-event-coverage";
import {
  routeBatchSegmentOutcome,
  type BatchEventCoverageStage,
  type BatchSegmentOutcomeRoute,
} from "@/lib/batch-segment-outcome-router";
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
  message?: string;
  errorCode?: string;
  retryable?: boolean;
  requestId?: string;
  idempotentReplay?: boolean;
};

type BatchSaveRecoveryDescriptor = {
  recoveryKey: string;
  durableBatchId: string;
  sourceHash: string;
  projectId?: string | null;
  fromRegistry?: boolean;
};

type BatchRecoveryDiscovery =
  | { status: "none"; descriptor: null }
  | { status: "recoverable"; descriptor: BatchSaveRecoveryDescriptor }
  | { status: "unavailable"; descriptor: null; message: string };

function readBatchRecoveryRegistry() {
  if (typeof window === "undefined") return [];
  return parseSegmentBatchRecoveryRegistry(
    window.localStorage.getItem(SEGMENT_BATCH_RECOVERY_REGISTRY_KEY),
  );
}

function writeBatchRecoveryRegistry(registry: readonly SegmentBatchRecoveryPointer[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    SEGMENT_BATCH_RECOVERY_REGISTRY_KEY,
    JSON.stringify(registry),
  );
}

function rememberBatchRecoveryPointer(pointer: SegmentBatchRecoveryPointer) {
  writeBatchRecoveryRegistry(
    upsertSegmentBatchRecoveryPointer(readBatchRecoveryRegistry(), pointer),
  );
}

function forgetBatchRecoveryPointer(durableBatchId: string) {
  writeBatchRecoveryRegistry(
    removeSegmentBatchRecoveryPointer(readBatchRecoveryRegistry(), durableBatchId),
  );
}

type CachedRenderedEpisode = {
  episodeIndex?: number;
  title?: string;
  sourceText?: string;
  promptText?: string;
  result?: AnalysisResult;
  status?: SegmentQualityStatus | "review_saved" | "saved";
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

type BatchSegmentRepairCodexJob = {
  id: string;
  contractHash?: string;
  resultHash: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: BatchSegmentRepairPatchResult | null;
  error?: string | null;
};

type BatchSegmentRepairPollResult =
  | { status: "completed"; job: BatchSegmentRepairCodexJob }
  | { status: "detached"; job: BatchSegmentRepairCodexJob };

type EventCoverageJudgeDecision = {
  segmentIndex: number;
  slotId: string;
  status: "covered" | "missing" | "contradiction" | "uncertain";
  evidence: Array<{ path: string; quote: string }>;
  inspectedPaths: string[];
};

type EventCoverageCodexJob = {
  id: string;
  waveId: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: { schemaVersion: 1; waveId: string; decisions: EventCoverageJudgeDecision[] } | null;
  error?: string | null;
};

type VideoPromptPackCodexJob = {
  id: string;
  protocolVersion?: number;
  stage?: string;
  batchId?: string;
  operationToken?: string;
  sourceHash?: string;
  aggregateContractHash?: string;
  segmentIndexes?: number[];
  contractHashes?: Record<string, string>;
  resultAvailable?: boolean;
  resultHash?: string;
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
      resultHash?: string;
      coverageSidecar?: SegmentCoverageSidecar | null;
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
  segmentContract?: SegmentContract;
};

type SeasonPackCodexJob = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  segmentCountMode?: SegmentCountMode;
  requestedEpisodeCount?: number | null;
  resolvedEpisodeCount?: number | null;
  episodeCount: number;
  featureFlags?: BatchEventFeatureSnapshot;
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

class RenderPackPollingInfrastructureError extends Error {
  readonly jobId: string;

  constructor(jobId: string, message: string) {
    super(message);
    this.name = "RenderPackPollingInfrastructureError";
    this.jobId = jobId;
  }
}

class StaleSegmentOperationError extends Error {
  readonly code = "STALE_SEGMENT_OPERATION";

  constructor(
    readonly segmentIndex: number,
    readonly operation: "render" | "repair",
  ) {
    super(`Segment ${segmentIndex} ${operation} result is stale`);
    this.name = "StaleSegmentOperationError";
  }
}

function isRenderPackPollingInfrastructureError(error: unknown): error is RenderPackPollingInfrastructureError {
  return error instanceof RenderPackPollingInfrastructureError;
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
type BatchGenerationPhase =
  | "planning"
  | "rendering"
  | "validating"
  | "adjudicating"
  | "patching"
  | "repairing"
  | "saving"
  | "needs_review"
  | "quota_paused"
  | "completed"
  | "failed";
type BatchSegmentStatus = BatchSegmentProgressStatus;
type BatchRepairReasonType =
  | "encoding"
  | "schema"
  | "segment-label"
  | "duration"
  | "shot-density"
  | "contract"
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
  startedAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
  elapsedMs: number;
  completedCount: number;
  savedCount: number;
  cachedCount: number;
  runningCount: number;
  pendingCount: number;
  repairingCount: number;
  adjudicatingCount: number;
  needsReviewCount: number;
  savingCount: number;
  currentMessage: string;
  segments: BatchSegmentProgress[];
  qualityReportSummary?: BatchQualityReportSummary;
  invocationMetrics?: {
    renderPackCalls: number;
    singleRegenerationCalls: number;
    pathPatchJobCreated: number;
    pathPatchCompleted: number;
    judgeCalls: number;
    localPatchOperations: number;
  };
  timingMetrics?: {
    renderWallMs: number;
    repairWaitMs: number;
    saveMs: number;
    criticalPathMs: number;
  };
};

const MAX_EPISODE_BATCH_COUNT = 30;
const BATCH_RENDER_PACK_SIZE = 4;
const BATCH_RENDER_PACK_CONCURRENCY = 4;
const BATCH_SINGLE_RENDER_CONCURRENCY = 3;
const MAX_BATCH_REPAIR_ATTEMPTS_PER_REASON = 1;
const SLOW_RENDER_PACK_WARNING_MS = 8 * 60_000;
const STRICT_UTF8_RENDER_PACK_MODE: RenderPackCodexMode = "strictUtf8";
const MIN_BATCH_FULL_PROMPT_LENGTH = 900;
const TASK_ONE_SAFETY_ENABLED = process.env.NEXT_PUBLIC_TASK_ONE_SAFETY !== "0";
const TASK_ONE_STATE_REDUCER_ENABLED = process.env.NEXT_PUBLIC_TASK_ONE_STATE_REDUCER !== "0";
const TASK_ONE_CACHE_RECOVERY_ENABLED = process.env.NEXT_PUBLIC_TASK_ONE_CACHE_RECOVERY !== "0";
const TASK_ONE_REPAIR_SCHEDULER_ENABLED = process.env.NEXT_PUBLIC_TASK_ONE_REPAIR_SCHEDULER !== "0";
const BATCH_RENDER_LATE_RECONCILIATION_ENABLED = isBatchRenderLateReconciliationEnabled(
  process.env.NEXT_PUBLIC_BATCH_RENDER_LATE_RECONCILIATION,
);
const segmentTerminologyPattern = /(?:\u7b2c\s*[0-9\u4e00-\u9fa5]+\s*\u96c6|\u672c\u96c6|\u5355\u96c6|\u5267\u96c6)/;

function waitForRenderObservation(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("Render observation aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("Render observation aborted");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatBatchDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function formatBatchElapsedMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0秒";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function formatBatchSafetyRisk(risk: BatchQualityReportSummary["highestSafetyRisk"]) {
  const labels: Record<BatchQualityReportSummary["highestSafetyRisk"], string> = {
    none: "无",
    low: "低",
    medium: "中",
    high: "高",
  };
  return labels[risk] || risk;
}
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
  const contentType = cleanPromptContentType(result.contentType);
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

  const promptText = [
    `核心主题\n\n${coreTheme}`,
    `技术参数\n\n${technicalParams}`,
    `镜头画面 + 时间轴 + 声音 / 台词\n${shotLines}`,
  ].filter(Boolean).join("\n\n");

  return sanitizeInternalPromptTokens(promptText);
}

function cleanPromptValue(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null" || /\bundefined\b/.test(trimmed)) return fallback;
  return trimmed;
}

function cleanPromptContentType(value: unknown, fallback = "短剧 / 通用") {
  const raw = typeof value === "string" ? value.trim() : "";
  const sanitized = cleanPromptValue(raw ? sanitizeInternalPromptTokens(raw) : "", "");
  if (!sanitized || findInternalPromptToken(raw)) return fallback;
  if (/^(?:单段视频提示词结果|视频提示词结果|视频段)$/.test(sanitized)) return fallback;
  return sanitized;
}

function sanitizeBatchSegmentText(value: string) {
  const segmentSanitized = value
    .replace(/\u7b2c\s*([0-9\u4e00-\u9fa5]+)\s*\u96c6/g, "\u7b2c$1\u6bb5")
    .replace(/\u672c\u96c6/g, "\u672c\u6bb5")
    .replace(/\u5355\u96c6/g, "\u5355\u6bb5")
    .replace(/\u5267\u96c6/g, "\u5206\u6bb5")
    .replace(/16\s*:\s*9\s*\u7ad6\u5c4f/g, "16:9\u6a2a\u5c4f")
    .replace(/\u7ad6\u5c4f\s*16\s*:\s*9/g, "16:9\u6a2a\u5c4f")
    .replace(/\u6a2a\u5c4f\s*\u7ad6\u5c4f/g, "\u6a2a\u5c4f");
  return sanitizeInternalPromptTokens(segmentSanitized);
}

function sanitizeBatchNegativePrompt(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  const cleaned = sanitizeBatchSegmentText(raw)
    .replace(/\bundefined\b/gi, "\u7a7a\u5b57\u6bb5")
    .replace(/\bnull\b/gi, "\u7a7a\u503c");
  const baseItems = ["\u7a7a\u5b57\u6bb5\u5360\u4f4d\u8868\u8fbe", "\u8de8\u6bb5\u5f15\u7528\u5360\u4f4d\u8868\u8fbe", "\u4e0d\u53ef\u6267\u884c\u7701\u7565\u63cf\u8ff0", "16:9\u753b\u5e45\u65b9\u5411\u51b2\u7a81"];
  const parts = cleaned
    .split(/[,\uff0c\u3001]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const item of baseItems) {
    if (!parts.some((part) => part.includes(item))) parts.push(item);
  }
  return parts.join("\uff0c");
}

function normalizeBatchSegmentResultForQuality(result: AnalysisResult): AnalysisResult {
  const sanitized = sanitizeBatchSegmentOutput(result);
  const storyboard = Array.isArray(sanitized.storyboard)
    ? sanitized.storyboard.map((shot) => ({
      ...shot,
      dialogue: cleanPromptValue(shot.dialogue, "") || "\u65e0",
      negativePrompt: sanitizeBatchNegativePrompt(shot.negativePrompt),
    }))
    : [];
  const workflow = sanitized.workflow
    ? {
      ...sanitized.workflow,
      fullNegativePrompt: sanitizeBatchNegativePrompt(sanitized.workflow.fullNegativePrompt),
    }
    : sanitized.workflow;

  return {
    ...sanitized,
    workflow,
    storyboard,
  };
}

function canonicalizeBatchSegmentResult(result: AnalysisResult): AnalysisResult {
  const normalized = normalizeBatchSegmentResultForQuality(result);
  const canonicalFullVideoPrompt = buildVideoGenerationPromptText(normalized);
  const workflow = normalized.workflow
    ? {
      ...normalized.workflow,
      fullVideoPrompt: canonicalFullVideoPrompt,
      filmScript: canonicalFullVideoPrompt,
    }
    : normalized.workflow;

  return {
    ...normalized,
    workflow,
  };
}

function sanitizeBatchSegmentOutput<T>(value: T): T {
  return sanitizeInternalPromptTokensDeep(
    (function sanitizeSegmentLabels(item: unknown): unknown {
      if (typeof item === "string") return sanitizeBatchSegmentText(item);
      if (Array.isArray(item)) return item.map((entry) => sanitizeSegmentLabels(entry));
      if (!item || typeof item !== "object") return item;
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, sanitizeSegmentLabels(entry)]),
      );
    })(value),
  ) as T;
}

function classifyBatchRepairReason(reason: string): BatchRepairReasonType {
  if (/encoding|question marks|replacement characters|UTF-?8|parse|JSON/i.test(reason)) return "encoding";
  if (/contract|SegmentContract|requiredEvents|forbidden future event/i.test(reason)) return "contract";
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
    contract: "\u4e8b\u4ef6\u8986\u76d6\u4fee\u590d",
    quality: "\u8d28\u91cf\u4fee\u590d",
    "render-pack": "Render Pack \u4fee\u590d",
  };
  return labels[reasonType];
}

function buildBatchRepairAttemptKey(
  episodeIndex: number,
  reasonType: BatchRepairReasonType,
  findings: BatchSegmentQualityFinding[] = [],
) {
  const slotIds = Array.from(new Set(findings.map((finding) => finding.slotId).filter(Boolean))).sort();
  if (slotIds.length) return `${episodeIndex}:slot:${slotIds.join("+")}`;
  const paths = Array.from(new Set(findings.map((finding) => normalizeBatchSegmentRepairPath(finding.path)).filter(Boolean))).sort();
  return `${episodeIndex}:${reasonType}:${paths.join("+") || "segment"}`;
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
  const contentType = cleanPromptContentType(
    result.contentType,
    inferPromptContentType(baseScript) || "短剧 / 通用",
  );
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

  return canonicalizeBatchSegmentResult(normalized);
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

function minimumBatchFullPromptLength(storyboard: unknown[]) {
  return storyboard.length ? MIN_BATCH_FULL_PROMPT_LENGTH : 900;
}

function legacyFatalCheck(
  episodeIndex: number,
  result: AnalysisResult,
  gate: ReturnType<typeof evaluateBatchSegmentQuality>,
) {
  if (!result || typeof result !== "object") throw new Error(`第 ${episodeIndex} 段生成失败：结果不是有效对象。`);
  if (!Array.isArray(result.storyboard)) throw new Error(`第 ${episodeIndex} 段生成失败：storyboard 不是数组。`);
  if (gate.blockingFindings.length > 0) throw new Error(buildTargetedRepairReason(gate));
  try {
    JSON.stringify(result);
  } catch {
    throw new Error(`第 ${episodeIndex} 段生成失败：结果无法序列化。`);
  }
  if (!cleanPromptValue(buildVideoGenerationPromptText(result), "")) {
    throw new Error(`第 ${episodeIndex} 段生成失败：保存前 canonical prompt 为空。`);
  }
}

class BatchSegmentQualityValidationError extends Error {
  gate: ReturnType<typeof evaluateBatchSegmentQuality>;
  findings: BatchSegmentQualityFinding[];
  result?: AnalysisResult;
  coverageDecisions: CoverageDecision[];

  constructor(
    gate: ReturnType<typeof evaluateBatchSegmentQuality>,
    result?: AnalysisResult,
    coverageDecisions: CoverageDecision[] = [],
  ) {
    super(buildTargetedRepairReason(gate));
    this.name = "BatchSegmentQualityValidationError";
    this.gate = gate;
    this.findings = gate.blockingFindings.length ? gate.blockingFindings : gate.findings;
    this.result = result;
    this.coverageDecisions = coverageDecisions;
  }
}

function qualityGateWithBlockingFindings(
  gate: BatchSegmentQualityGate,
  blockingFindings: BatchSegmentQualityFinding[],
): BatchSegmentQualityGate {
  const blockingSet = new Set(blockingFindings);
  const findings = gate.findings.filter((finding) => finding.severity !== "blocking" || blockingSet.has(finding));
  return {
    ...gate,
    findings,
    blockingFindings,
  };
}

function qualityErrorForRoute(
  gate: BatchSegmentQualityGate,
  route: BatchSegmentOutcomeRoute,
  result?: AnalysisResult,
  coverageDecisions: CoverageDecision[] = [],
) {
  const candidateFindings = route.repairFindings.length ? route.repairFindings : route.structuralFindings;
  const firstSlotId = candidateFindings.find((finding) => finding.slotId)?.slotId;
  const repairFindings = firstSlotId
    ? candidateFindings.filter((finding) => finding.slotId === firstSlotId)
    : candidateFindings;
  return new BatchSegmentQualityValidationError(
    qualityGateWithBlockingFindings(gate, repairFindings),
    result,
    coverageDecisions,
  );
}

function normalizePatchAndEvaluateBatchSegment(
  baseScript: string,
  episodeIndex: number,
  result: AnalysisResult,
  requestedDuration: string,
  contract?: SegmentContract,
  coverageSidecar?: SegmentCoverageSidecar | null,
  coverageDecisionOverrides?: CoverageDecision[],
  coverageMode: "shadow" | "active" = "shadow",
) {
  const normalizedResult = normalizeBatchSegmentResultForQuality(result);
  const sourceInfo = inferBatchEpisodeSourceInfo(baseScript, episodeIndex);
  const coverageStartedAt = Date.now();
  const buildQualityOptions = (candidate: AnalysisResult) => {
    const maxShotCount = maximumBatchStoryboardShotCount(candidate, requestedDuration);
    const minShotCount = sourceInfo.shotCount > 0 ? 0 : minimumBatchStoryboardShotCount(candidate, requestedDuration);
    return {
      segmentIndex: episodeIndex,
      expectedShotCount: contract?.shotCount,
      sourceShotCount: sourceInfo.shotCount,
      minShotCount,
      maxShotCount,
      requestedDuration,
      contract,
      coverageDecisions: contract
        ? coverageDecisionOverrides || validateSegmentEventCoverage(candidate, contract, coverageSidecar)
        : undefined,
      coverageMode,
      fullPromptText: buildVideoGenerationPromptText(candidate),
      minFullPromptLength: minimumBatchFullPromptLength(candidate.storyboard || []),
    };
  };
  const firstGate = evaluateBatchSegmentQuality(normalizedResult, {
    ...buildQualityOptions(normalizedResult),
  });
  const deterministicPatchFindings = selectDeterministicQualityPatchFindings(
    firstGate.findings,
    { safetyEnabled: TASK_ONE_SAFETY_ENABLED },
  );
  const patched = applyDeterministicQualityPatchWithDiff(
    normalizedResult,
    deterministicPatchFindings,
  );
  const hasDeterministicChanges = patched.patchDiffs.length > 0;
  const patchedResult = canonicalizeBatchSegmentResult(patched.result);
  const finalGate = hasDeterministicChanges
    ? evaluateBatchSegmentQuality(patchedResult, {
        ...buildQualityOptions(patchedResult),
      })
    : firstGate;

  return {
    result: patchedResult,
    firstGate,
    gate: finalGate,
    patchDiffs: patched.patchDiffs,
    localPatchSummary: summarizeQualityFindings([...firstGate.findings, ...finalGate.findings]),
    coverageDecisions: contract
      ? coverageDecisionOverrides || validateSegmentEventCoverage(patchedResult, contract, coverageSidecar)
      : [],
    coverageDurationMs: Math.max(0, Date.now() - coverageStartedAt),
  };
}

function normalizePatchAndValidateBatchSegment(
  baseScript: string,
  episodeIndex: number,
  result: AnalysisResult,
  requestedDuration: string,
  contract?: SegmentContract,
  coverageSidecar?: SegmentCoverageSidecar | null,
  coverageDecisionOverrides?: CoverageDecision[],
  coverageMode: "shadow" | "active" = "shadow",
) {
  const evaluated = normalizePatchAndEvaluateBatchSegment(
    baseScript,
    episodeIndex,
    result,
    requestedDuration,
    contract,
    coverageSidecar,
    coverageDecisionOverrides,
    coverageMode,
  );
  if (shouldRepairWithCodex(evaluated.gate)) {
    throw new BatchSegmentQualityValidationError(evaluated.gate, evaluated.result, evaluated.coverageDecisions);
  }
  legacyFatalCheck(episodeIndex, evaluated.result, evaluated.gate);
  return evaluated;
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
    "最终输出必须是 Local Director 完整视频提示词结果 JSON，由本地视频提示词 Codex worker 写入文件。",
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
  const [batchSaveRecovery, setBatchSaveRecovery] = useState<BatchSaveRecoveryDescriptor | null>(null);
  const [batchRecoveryChecking, setBatchRecoveryChecking] = useState(false);
  const batchRecoveryLookupRef = useRef<Promise<BatchRecoveryDiscovery> | null>(null);
  const batchRecoveryLookupKeyRef = useRef("");
  const renderRecoveryObserverRegistryRef = useRef(
    createRenderPackObserverRegistry<RenderObservationOutcome<VideoPromptPackCodexJob>>(),
  );
  const renderPackObserverRegistryRef = useRef(
    createRenderPackObserverRegistry<void>(),
  );
  const [batchProgressTick, setBatchProgressTick] = useState(0);
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
    if (!batchProgress || batchProgress.phase === "completed" || batchProgress.phase === "failed") return;
    setBatchProgressTick(Date.now());
    const timer = window.setInterval(() => setBatchProgressTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [batchProgress?.startedAtMs, batchProgress?.phase]);

  useEffect(() => () => {
    renderRecoveryObserverRegistryRef.current.abortAll();
    renderPackObserverRegistryRef.current.abortAll();
  }, []);

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

  async function discoverBatchSaveRecovery(): Promise<BatchRecoveryDiscovery> {
    if (!TASK_ONE_CACHE_RECOVERY_ENABLED || typeof window === "undefined") {
      return { status: "none", descriptor: null };
    }
    type RecoveryCandidate = {
      recoveryKey: string;
      durableBatchId?: string;
      sourceHash: string;
      projectId?: string | null;
      fromRegistry: boolean;
    };
    const registryCandidates = readBatchRecoveryRegistry().map((pointer) => ({
      recoveryKey: pointer.recoveryKey,
      durableBatchId: pointer.durableBatchId,
      sourceHash: pointer.sourceHash,
      projectId: pointer.projectId,
      fromRegistry: true as const,
    }));
    const legacySourceHash = script.trim()
      ? buildBatchSegmentResultHash({
          mode: segmentCountMode,
          episodeCount,
          duration: selectedDurationValue(),
          sourceText: script,
        })
      : "";
    const legacyCandidates = script.trim()
      ? buildSegmentBatchRecoveryKeys({
          projectId: resumeProjectId || null,
          sourceHash: legacySourceHash,
          mode: segmentCountMode,
          requestedCount: segmentCountMode === "auto" ? null : episodeCount,
          duration: selectedDurationValue(),
        }).map((recoveryKey) => ({
          recoveryKey,
          sourceHash: legacySourceHash,
          projectId: resumeProjectId || null,
          fromRegistry: false as const,
        }))
      : [];
    const candidates = [...registryCandidates, ...legacyCandidates] as RecoveryCandidate[];
    if (!candidates.length) return { status: "none", descriptor: null };

    let infrastructureFailure = "";
    const inspectedBatchIds = new Set<string>();
    try {
      for (const candidate of candidates) {
        let durableBatchId = candidate.durableBatchId || "";
        if (!candidate.fromRegistry) {
          try {
            const raw = window.localStorage.getItem(candidate.recoveryKey);
            const index = raw ? JSON.parse(raw) as Record<string, unknown> : null;
            durableBatchId = typeof index?.durableBatchId === "string"
              ? index.durableBatchId
              : typeof index?.batchId === "string" ? index.batchId : "";
            if (!durableBatchId || index?.sourceHash !== candidate.sourceHash) continue;
          } catch (legacyIndexError) {
            console.warn("Failed to read legacy batch recovery index", legacyIndexError);
            window.localStorage.removeItem(candidate.recoveryKey);
            continue;
          }
        }
        if (inspectedBatchIds.has(durableBatchId)) continue;
        inspectedBatchIds.add(durableBatchId);

        let response: Response;
        try {
          response = await fetch(`/api/segment-batch-cache/${encodeURIComponent(durableBatchId)}`, {
            method: "GET",
            cache: "no-store",
          });
        } catch (cacheReadError) {
          console.warn("Failed to read batch recovery cache", cacheReadError);
          infrastructureFailure ||= formatUserFacingError(
            cacheReadError,
            "分段缓存服务暂时不可用，无法确认是否存在待保存结果。",
          );
          continue;
        }
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          if ([400, 404, 410].includes(response.status)) {
            window.localStorage.removeItem(candidate.recoveryKey);
            forgetBatchRecoveryPointer(durableBatchId);
            continue;
          }
          infrastructureFailure ||= formatUserFacingError(
            data?.error || `分段缓存服务返回 ${response.status}`,
            "分段缓存服务暂时不可用，无法确认是否存在待保存结果。",
          );
          continue;
        }
        if (!data?.ok || !data.cache) {
          infrastructureFailure ||= "分段缓存服务返回了无效数据，无法确认是否存在待保存结果。";
          continue;
        }

        const cache = data.cache as SegmentBatchCacheDocumentV2;
        const activeProjectMatches = !resumeProjectId || !cache.projectId || cache.projectId === resumeProjectId;
        if (!activeProjectMatches) continue;
        const pointerProjectMatches = !candidate.projectId || !cache.projectId || cache.projectId === candidate.projectId;
        const cacheIdentityMatches = cache.schemaVersion === 2
          && cache.durableBatchId === durableBatchId
          && cache.sourceHash === candidate.sourceHash
          && pointerProjectMatches
          && Array.isArray(cache.segments)
          && Array.isArray(cache.segmentStates);
        if (!cacheIdentityMatches) {
          window.localStorage.removeItem(candidate.recoveryKey);
          forgetBatchRecoveryPointer(durableBatchId);
          continue;
        }
        const hasUnsavedSegments = cache.segmentStates.some(
          (state) => state.saveStatus !== "saved" && state.saveStatus !== "review_saved",
        ) && cache.segments.length > 0;
        if (hasUnsavedSegments) {
          return {
            status: "recoverable",
            descriptor: {
              recoveryKey: candidate.recoveryKey,
              durableBatchId,
              sourceHash: candidate.sourceHash,
              projectId: cache.projectId || candidate.projectId,
              fromRegistry: candidate.fromRegistry,
            },
          };
        }
        window.localStorage.removeItem(candidate.recoveryKey);
        forgetBatchRecoveryPointer(durableBatchId);
      }
    } catch (recoveryIndexError) {
      console.warn("Failed to read batch recovery index", recoveryIndexError);
      infrastructureFailure ||= formatUserFacingError(
        recoveryIndexError,
        "无法读取分段恢复索引，暂不能开始新的分段生成。",
      );
    }
    if (infrastructureFailure) {
      return { status: "unavailable", descriptor: null, message: infrastructureFailure };
    }
    return { status: "none", descriptor: null };
  }

  function ensureBatchSaveRecoveryDiscovery() {
    if (!TASK_ONE_CACHE_RECOVERY_ENABLED) {
      return Promise.resolve({ status: "none", descriptor: null } satisfies BatchRecoveryDiscovery);
    }
    const lookupKey = JSON.stringify({
      duration: selectedDurationValue(),
      episodeCount,
      projectId: resumeProjectId || null,
      script,
      segmentCountMode,
    });
    if (batchRecoveryLookupRef.current && batchRecoveryLookupKeyRef.current === lookupKey) {
      return batchRecoveryLookupRef.current;
    }
    const lookup = discoverBatchSaveRecovery();
    batchRecoveryLookupKeyRef.current = lookupKey;
    batchRecoveryLookupRef.current = lookup;
    void lookup.finally(() => {
      if (batchRecoveryLookupRef.current === lookup) {
        batchRecoveryLookupRef.current = null;
        batchRecoveryLookupKeyRef.current = "";
      }
    });
    return lookup;
  }

  useEffect(() => {
    if (!TASK_ONE_CACHE_RECOVERY_ENABLED || batchGenerating) {
      if (!batchGenerating) setBatchSaveRecovery(null);
      setBatchRecoveryChecking(false);
      return;
    }
    let active = true;
    setBatchRecoveryChecking(true);
    void ensureBatchSaveRecoveryDiscovery()
      .then((discovery) => {
        if (!active) return;
        setBatchSaveRecovery(discovery.descriptor);
        if (discovery.status === "unavailable") {
          setError(discovery.message);
        }
      })
      .finally(() => {
        if (active) setBatchRecoveryChecking(false);
      });
    return () => {
      active = false;
    };
  }, [
    batchGenerating,
    durationMode,
    durationSeconds,
    episodeCount,
    resumeProjectId,
    script,
    segmentCountMode,
  ]);

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

  async function createBatchSegmentRepairCodexJob(input: {
    projectId?: string;
    batchId: string;
    segmentIndex: number;
    slotId?: string;
    contractHash: string;
    resultHash: string;
    sourceTextForModel: string;
    allowedPaths: string[];
    currentValues: Record<string, string>;
    findings: Array<{ code: string; message: string; path?: string; slotId?: string }>;
    forbiddenFutureEvents?: string[];
  }) {
    await assertCodexWorkerRuntimeHealthy("batch-segment-repair");
    const res = await fetch("/api/batch-segment-repair/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Codex 路径级修复任务创建失败");
    }
    return data.job as BatchSegmentRepairCodexJob;
  }

  async function pollBatchSegmentRepairCodexJob(jobId: string): Promise<BatchSegmentRepairPollResult> {
    const startedAt = Date.now();
    const timeoutMs = REPAIR_FRONTEND_WAIT_TIMEOUT_MS;
    let lastStatus = "";
    let lastJob: BatchSegmentRepairCodexJob | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      const currentJob = await queryBatchSegmentRepairCodexJob(jobId);
      lastJob = currentJob;
      if (currentJob.status !== lastStatus) {
        lastStatus = currentJob.status;
        setGenerationProgress(
          currentJob.status === "running"
            ? "Codex 正在只修复未通过质量闸的字段..."
            : `Codex 路径级修复任务状态：${currentJob.status}`,
        );
      }
      if (currentJob.status === "completed") return { status: "completed", job: currentJob };
      if (currentJob.status === "failed") {
        throw new CodexVideoPromptJobFailedError(currentJob.error || "Codex 路径级修复任务失败");
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return {
      status: "detached",
      job: lastJob || { id: jobId, resultHash: "", status: "running" },
    };
  }

  async function queryBatchSegmentRepairCodexJob(jobId: string) {
    const res = await fetch(`/api/batch-segment-repair/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Codex 路径级修复任务读取失败");
    }
    return data.job as BatchSegmentRepairCodexJob;
  }

  async function requestBatchSegmentRepairPatchWithContext(input: {
    projectId?: string;
    batchId: string;
    segmentIndex: number;
    segmentContract?: SegmentContract;
    sourceText: string;
    failedResult: AnalysisResult;
    findings: BatchSegmentQualityFinding[];
    onJobCreated?: (input: { jobId: string; contractHash: string; resultHash: string }) => void;
  }) {
    const targetedFindings = input.findings
      .map((finding) => ({
        finding,
        path: normalizeBatchSegmentRepairPath(finding.path),
      }))
      .filter((item) => item.path && isAllowedBatchSegmentRepairPath(item.path))
      .slice(0, 16);
    if (!targetedFindings.length) {
      throw new Error(`第 ${input.segmentIndex} 段没有可安全路径修复的字段，已阻止整段结果 fallback。`);
    }

    const allowedPaths = Array.from(new Set(targetedFindings.map((item) => item.path)));
    const findingSlotIds = Array.from(new Set(targetedFindings.map((item) => item.finding.slotId).filter(Boolean)));
    const slotId = findingSlotIds.length === 1 ? findingSlotIds[0] : undefined;
    const currentValues = Object.fromEntries(
      allowedPaths.map((path) => [path, String(getBatchSegmentRepairValueAtPath(input.failedResult, path) ?? "")]),
    );
    const resultHash = buildBatchSegmentResultHash(input.failedResult);
    const contractHash = input.segmentContract?.contractHash
      || buildBatchSegmentResultHash({ segmentIndex: input.segmentIndex, sourceText: input.sourceText });
    const repairModelInput = applyPromptSafetyPolicyDeep({
      segmentIndex: input.segmentIndex,
      title: input.segmentContract?.title || input.failedResult.title,
      sourceText: input.segmentContract?.sourceText || input.sourceText,
      requiredEvents: input.segmentContract?.requiredEvents || [],
      requiredShotBeats: input.segmentContract?.requiredShotBeats || [],
      characters: input.segmentContract?.characters || [],
      locations: input.segmentContract?.locations || [],
      props: input.segmentContract?.props || [],
    }, { phase: "repair" });
    const sourceTextForModel = JSON.stringify(repairModelInput.sourceTextForModel);
    const job = await createBatchSegmentRepairCodexJob({
      projectId: input.projectId,
      batchId: input.batchId,
      segmentIndex: input.segmentIndex,
      slotId,
      contractHash,
      resultHash,
      sourceTextForModel,
      allowedPaths,
      currentValues,
      findings: targetedFindings.map(({ finding, path }) => ({
        code: finding.code,
        message: finding.message,
        path,
        slotId: finding.slotId,
      })),
      forbiddenFutureEvents: input.segmentContract?.forbiddenFutureEvents || [],
    });
    input.onJobCreated?.({ jobId: job.id, contractHash, resultHash });
    const polled = await pollBatchSegmentRepairCodexJob(job.id);
    if (polled.status === "detached") {
      return { detached: true as const, jobId: job.id, contractHash, resultHash };
    }
    const completedJob = polled.job;
    if (completedJob.resultHash !== resultHash) {
      throw new Error(`第 ${input.segmentIndex} 段同一事件槽已完成过一次修复，当前结果已变化，停止重复 patch。`);
    }
    if (!completedJob.result) {
      throw new CodexVideoPromptJobFailedError("Codex 路径级修复任务完成但没有返回 patch");
    }
    return {
      detached: false as const,
      jobId: completedJob.id,
      contractHash,
      resultHash,
      patch: completedJob.result,
    };
  }

  async function createEventCoverageCodexJob(input: {
    batchId: string;
    renderRound: string | number;
    cases: Array<{
      segmentIndex: number;
      slotId: string;
      label: string;
      importance: "blocking";
      contractHash: string;
      resultHash: string;
      anchorGroups: string[][];
      conceptGroups: string[][];
      contradictionGroups: string[][];
      sourceExcerpt: string;
      characterLocks: SegmentContract["characterLocks"];
      forbiddenFutureEvents: string[];
      evidenceSelectors: SegmentContract["requiredEventSlots"][number]["evidenceSelectors"];
      inspectedFields: Array<{ path: string; text: string }>;
    }>;
  }) {
    await assertCodexWorkerRuntimeHealthy("event-coverage");
    const res = await fetch("/api/event-coverage/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Codex 事件覆盖裁决任务创建失败");
    return data.job as EventCoverageCodexJob;
  }

  async function pollEventCoverageCodexJob(jobId: string) {
    const startedAt = Date.now();
    const timeoutMs = 12 * 60_000;
    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/event-coverage/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Codex 事件覆盖裁决任务读取失败");
      const job = data.job as EventCoverageCodexJob;
      if (job.status === "completed") return job;
      if (job.status === "failed") throw new CodexVideoPromptJobFailedError(job.error || "Codex 事件覆盖裁决任务失败");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("Codex 事件覆盖裁决任务等待超时，请确认 event-coverage:codex-worker 正在运行。");
  }

  async function createVideoPromptPackCodexJob(
    segments: Array<{
      episodeIndex: number;
      title: string;
      script: string;
      renderInputScript: string;
      duration: string;
      shotCount: number;
      segmentContract?: SegmentContract;
    }>,
    projectId: string | undefined,
    mode: RenderPackCodexMode = STRICT_UTF8_RENDER_PACK_MODE,
    coverageSidecarEnabled = true,
    operationIdentity?: Pick<RenderOperationRefV2, "batchId" | "operationToken" | "idempotencyKey">,
  ) {
    await assertCodexWorkerRuntimeHealthy("video-prompt-pack");
    const body = JSON.stringify({
      batchId: operationIdentity?.batchId,
      operationToken: operationIdentity?.operationToken,
      idempotencyKey: operationIdentity?.idempotencyKey,
      projectId: projectId || undefined,
      mode,
      coverageSidecarEnabled,
      segments,
    });
    let lastTransportError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res: Response;
      try {
        res = await fetch("/api/video-prompt-packs/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch (error) {
        lastTransportError = error;
        if (attempt > 0) throw error;
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Codex render pack job creation failed");
      }
      return data.job as VideoPromptPackCodexJob;
    }
    throw lastTransportError instanceof Error ? lastTransportError : new Error("Codex render pack job creation failed");
  }

  async function assertCodexWorkerRuntimeHealthy(workerName: string) {
    const res = await fetch(`/api/codex-runtime/health?worker=${encodeURIComponent(workerName)}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok && data?.health?.status === "healthy") return;
    if (data?.code === "CODEX_SKILL_CONFIG_INVALID") {
      const files = Array.isArray(data?.errors)
        ? data.errors.slice(0, 5).map((item: { path?: string; message?: string }) => `${item.path || "未知文件"}: ${item.message || "配置无效"}`)
        : [];
      throw new Error(`Codex Skill 配置无效，请修复后重启 worker。${files.length ? ` ${files.join("；")}` : ""}`);
    }
    throw new Error(data?.error || "本地 Codex worker 尚未运行，请启动 worker 后重试。");
  }

  async function createSeasonPackCodexJob(
    inputScript: string,
    inputDuration: string,
    projectId: string | undefined,
    mode: SegmentCountMode,
    requestedCount: number,
  ) {
    await assertCodexWorkerRuntimeHealthy("season-pack");
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

  async function readVideoPromptPackCodexJob(jobId: string, signal?: AbortSignal) {
    const response = await fetch(`/api/video-prompt-packs/jobs/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data.job) {
      throw Object.assign(
        new Error(data?.error || `Codex render pack job read failed (${response.status})`),
        { status: response.status, code: data?.errorCode || data?.code },
      );
    }
    return data.job as VideoPromptPackCodexJob;
  }

  async function pollVideoPromptPackCodexJob(jobId: string, segmentCount: number) {
    const attentionMs = Math.max(30 * 60_000, segmentCount * 600_000);
    let lastStatus = "";
    const outcome = await observeRenderPackJob({
      jobId,
      mode: "foreground",
      attentionMs,
      readJob: readVideoPromptPackCodexJob,
      sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
      onStage(currentJob) {
        if (currentJob.status === lastStatus) return;
        lastStatus = currentJob.status;
        setGenerationProgress(
          currentJob.status === "running"
            ? `Codex 正在本地生成 ${segmentCount} 段 Render Pack...`
            : `Codex Render Pack 任务状态：${currentJob.status}`,
        );
      },
    });
    if (outcome.status === "completed") return outcome.job;
    if (outcome.status === "terminal_failed" && outcome.job?.status === "failed") {
      throw new CodexVideoPromptJobFailedError(outcome.job.error || "Codex render pack job failed");
    }
    throw new RenderPackPollingInfrastructureError(
      jobId,
      outcome.status === "detached"
        ? "Codex Render Pack 前台等待已结束；原任务仍保留，不会降级为逐段重新生成。"
        : `Codex Render Pack 状态不可继续读取（${outcome.status === "terminal_failed" ? outcome.reasonCode : "aborted"}）。`,
    );
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
    idempotencyKey?: string,
    status?: string,
  ): Promise<ProjectSaveState> {
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          status,
          projectId,
          versionId,
          originalScript,
          result: analysisResult,
          fullVideoPrompt,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        return {
          saved: false,
          reason: data?.message || data?.error || "Project save failed",
          message: data?.message || data?.error || "Project save failed",
          errorCode: data?.errorCode || "PROJECT_API_UNAVAILABLE",
          retryable: Boolean(data?.retryable),
          requestId: data?.requestId,
        };
      }
      return (data.save || { saved: true }) as ProjectSaveState;
    } catch (err) {
      return {
        saved: false,
        reason: err instanceof Error ? err.message : "Project save failed",
        message: err instanceof Error ? err.message : "Project save failed",
        errorCode: "PROJECT_API_UNAVAILABLE",
        retryable: true,
      };
    }
  }

  async function resumeCachedRenderOperations(input: {
    cache: SegmentBatchCacheDocumentV2;
    stateByIndex: Map<number, SegmentStateRecord>;
    persist: () => Promise<void>;
  }) {
    const { cache, stateByIndex, persist } = input;
    let recoveryPersistChain = Promise.resolve();
    const persistRecoveryState = () => {
      const next = recoveryPersistChain.then(() => persist());
      recoveryPersistChain = next.then(() => undefined, () => undefined);
      return next;
    };
    let operations = retainBoundedRenderOperationAudits(cache.renderOperations || []);
    const replaceOperation = (operation: RenderOperationRefV2) => {
      operations = retainBoundedRenderOperationAudits([
        ...operations.filter((item) => item.operationToken !== operation.operationToken),
        operation,
      ]);
      cache.renderOperations = operations;
      cache.activeJobIds = operations
        .filter((item) => ["observing", "detached"].includes(item.state) && item.jobId)
        .map((item) => String(item.jobId));
    };
    const dispatch = (segmentIndex: number, event: SegmentStateEvent) => {
      const current = stateByIndex.get(segmentIndex);
      if (!current) return;
      stateByIndex.set(segmentIndex, reduceSegmentState(current, {
        ...event,
        baseRevision: current.revision,
      }));
    };
    const markInfrastructureFailure = async (operation: RenderOperationRefV2, errorCode: string) => {
      const failed = terminateRenderOperation(operation, { state: "failed", errorCode });
      replaceOperation(failed);
      for (const segmentIndex of operation.segmentIndexes) {
        dispatch(segmentIndex, {
          type: "RENDER_OPERATION_FAILED",
          operationToken: operation.operationToken,
          errorCode,
          message: "原 Render Pack 无法继续读取，已保留批次现场，不会触发补生成。",
        });
      }
      await persistRecoveryState();
    };

    const creatingOperations = operations.filter((operation) => operation.state === "creating");
    await Promise.allSettled(creatingOperations.map(async (draft) => {
      const context = draft.reconciliationContext;
      if (!context?.segments.length) {
        await markInfrastructureFailure(draft, "RENDER_RECOVERY_CONTEXT_MISSING");
        return;
      }
      const segments = context.segments.map((segment) => {
        const episodeInput: SeasonPackEpisodeInput = {
          episodeIndex: segment.episodeIndex,
          title: segment.title,
          sourceText: segment.sourceText,
          duration: segment.duration,
          contentType: "短剧",
          style: "写实",
          storyBible: null,
          episodeChain: null,
          blueprint: null,
          shotCount: segment.shotCount || segment.segmentContract?.shotCount || 4,
          renderInputScript: segment.sourceText,
          segmentContract: segment.segmentContract,
        };
        return {
          episodeIndex: segment.episodeIndex,
          title: segment.title,
          script: segment.sourceText,
          renderInputScript: buildBatchEpisodeRenderScript(episodeInput, cache.resolvedSegmentCount),
          duration: segment.duration,
          shotCount: episodeInput.shotCount,
          segmentContract: segment.segmentContract,
        };
      });
      const createResult = await retryCreatingRenderOperation({
        operation: draft,
        maxAttempts: 3,
        create: () => createVideoPromptPackCodexJob(
          segments,
          cache.projectId || undefined,
          STRICT_UTF8_RENDER_PACK_MODE,
          true,
          draft,
        ),
        sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
      });
      if (createResult.status === "created") {
        const job = createResult.value;
        const observing = attachRenderOperationJob(draft, {
          jobId: job.id,
          sourceHash: String(job.sourceHash || ""),
          aggregateContractHash: job.aggregateContractHash || null,
        });
        replaceOperation(observing);
        for (const segmentIndex of observing.segmentIndexes) {
          dispatch(segmentIndex, {
            type: "RENDER_OPERATION_OBSERVING",
            operationToken: observing.operationToken,
            jobId: job.id,
            expectedSourceHash: String(job.sourceHash || ""),
          });
        }
        await persistRecoveryState();
        return;
      }
      if (createResult.status === "transient") {
        replaceOperation({ ...draft, lastErrorCode: createResult.errorCode });
        await persistRecoveryState();
        return;
      }
      await markInfrastructureFailure(draft, createResult.errorCode);
    }));

    async function reconcileRecoveredJob(operation: RenderOperationRefV2, job: VideoPromptPackCodexJob) {
      const jobId = String(operation.jobId || job.id || "");
      const currentSegments = Object.fromEntries(operation.segmentIndexes.map((segmentIndex) => {
        const state = stateByIndex.get(segmentIndex);
        return [String(segmentIndex), {
          operationToken: state?.renderOperationToken,
          sourceHash: state?.expectedSourceHash,
          contractHash: state?.expectedContractHash || state?.contractHash,
          resultHash: state?.resultHash,
        }];
      }));
      const decision = reconcileDetachedRenderPack({
        operation,
        job,
        manifestValidated: job.protocolVersion === 2
          && job.resultAvailable === true
          && Boolean(job.resultHash),
        currentSegments,
      });
      if (decision.status === "failed") {
        await markInfrastructureFailure(operation, decision.errorCode);
        return;
      }
      if (decision.status === "ignored") {
        replaceOperation(terminateRenderOperation(operation, {
          state: "ignored",
          reasonCode: decision.reasonCode,
        }));
        for (const segmentIndex of decision.segmentIndexes) {
          dispatch(segmentIndex, {
            type: "RENDER_OPERATION_IGNORED",
            operationToken: operation.operationToken,
            reasonCode: decision.reasonCode,
          });
        }
        await persistRecoveryState();
        return;
      }
      if (decision.status === "waiting") return;
      if (decision.status === "replay") {
        if (operation.state !== "merged") {
          replaceOperation(terminateRenderOperation(operation, {
            state: "merged",
            finalManifestHash: String(job.resultHash),
            resultHashes: decision.resultHashes,
          }));
          await persistRecoveryState();
        }
        return;
      }

      const context = operation.reconciliationContext;
      try {
        const prepared = prepareRenderPackReconciliation({
          operation,
          eligibleSegmentIndexes: decision.segmentIndexes,
          contexts: context?.segments || [],
          results: job.result?.segments || [],
          prepareSegment: ({ segmentIndex, context: segmentContext, result: packed }) => {
            const normalized = normalizeBatchEpisodeResult(
              context?.sourceText || segmentContext.sourceText,
              segmentIndex,
              cache.resolvedSegmentCount,
              packed.result,
              segmentContext.duration,
            );
            const coverageStage = (cache.coverageStage || "shadow") as BatchEventCoverageStage;
            const evaluated = normalizePatchAndEvaluateBatchSegment(
              context?.sourceText || segmentContext.sourceText,
              segmentIndex,
              normalized,
              segmentContext.duration,
              segmentContext.segmentContract,
              packed.coverageSidecar as SegmentCoverageSidecar | null | undefined,
              undefined,
              coverageStageUsesLocalGate(coverageStage) ? "active" : "shadow",
            );
            const outcome = routeBatchSegmentOutcome({
              gate: evaluated.gate,
              hasUsableResult: true,
              coverageStage,
            });
            const needsReview = outcome.action !== "accept";
            return {
              segmentContext,
              packed,
              evaluated,
              needsReview,
              reason: buildTargetedRepairReason(evaluated.gate),
            };
          },
        });

        await applyPreparedRenderPackReconciliation(prepared, {
          applySegment: ({ segmentContext, packed, evaluated, needsReview, reason }, segmentIndex) => {
            dispatch(segmentIndex, {
              type: "RENDER_OPERATION_RECONCILED",
              operationToken: operation.operationToken,
              jobId,
              resultHash: packed.resultHash!,
              contractHash: segmentContext.segmentContract?.contractHash,
            });
            dispatch(segmentIndex, needsReview
              ? { type: "QUALITY_NEEDS_REVIEW", message: reason }
              : { type: "QUALITY_PASSED" });
            dispatch(segmentIndex, { type: "CACHE_READY" });
            const cachedSegment: CachedRenderedEpisode = {
              episodeIndex: segmentIndex,
              title: segmentContext.title,
              sourceText: segmentContext.sourceText,
              promptText: buildVideoGenerationPromptText(evaluated.result),
              result: evaluated.result,
              status: needsReview ? "needs_review" : "cached",
            };
            cache.segments = [
              ...(cache.segments as CachedRenderedEpisode[])
                .filter((segment) => Number(segment.episodeIndex) !== segmentIndex),
              cachedSegment,
            ].sort((left, right) => Number(left.episodeIndex) - Number(right.episodeIndex));
            if (needsReview) {
              cache.needsReviewSegments = [
                ...(cache.needsReviewSegments as Array<Record<string, unknown>>)
                  .filter((segment) => Number(segment.episodeIndex) !== segmentIndex),
                { episodeIndex: segmentIndex, reason, result: evaluated.result },
              ];
            }
          },
          finalize: async () => {
            replaceOperation(terminateRenderOperation(operation, {
              state: "merged",
              finalManifestHash: String(job.resultHash),
              resultHashes: decision.resultHashes,
            }));
            await persistRecoveryState();
          },
        });
      } catch {
        const detached = detachRenderOperation(operation, {
          errorCode: "RENDER_RECONCILIATION_PREPARATION_FAILED",
        });
        replaceOperation(detached);
        for (const segmentIndex of operation.segmentIndexes) {
          dispatch(segmentIndex, {
            type: "RENDER_OPERATION_DETACHED",
            operationToken: operation.operationToken,
            jobId,
          });
        }
        await persistRecoveryState();
      }
    }

    const recoverable = listRecoverableRenderOperations(operations);
    const recoveryObservers = startConcurrentRenderRecoveryObservers<
      VideoPromptPackCodexJob,
      RenderObservationOutcome<VideoPromptPackCodexJob>
    >({
      operations: recoverable,
      registry: renderRecoveryObserverRegistryRef.current,
      observe: (operation, signal) => observeRenderPackJob({
        jobId: String(operation.jobId),
        mode: "background",
        signal,
        readJob: readVideoPromptPackCodexJob,
        sleep: waitForRenderObservation,
        isHidden: () => typeof document !== "undefined" && document.hidden,
      }),
      async onOutcome(operation, outcome) {
        if (outcome.status === "completed") {
          await reconcileRecoveredJob(operation, outcome.job);
          return;
        }
        if (outcome.status === "terminal_failed") {
          if (outcome.job) {
            await reconcileRecoveredJob(operation, outcome.job);
          } else {
            await markInfrastructureFailure(operation, outcome.reasonCode);
          }
        }
      },
    });
    void recoveryObservers.settled;

    const segmentStates = [...stateByIndex.values()];
    return hasActiveRenderRecovery(operations)
      || hasSaveableUnsavedResults(segmentStates);
  }

  async function resumeCachedBatchSavesOnly(
    descriptor: BatchSaveRecoveryDescriptor | null = batchSaveRecovery,
  ) {
    if (!descriptor || !TASK_ONE_CACHE_RECOVERY_ENABLED) return false;
    setBatchGenerating(true);
    setError("");
    const startedAtMs = Date.now();
    try {
      const response = await fetch(`/api/segment-batch-cache/${encodeURIComponent(descriptor.durableBatchId)}`, {
        method: "GET",
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data.cache) {
        if ((response.ok && !data?.cache) || [400, 404, 410].includes(response.status)) {
          window.localStorage.removeItem(descriptor.recoveryKey);
          forgetBatchRecoveryPointer(descriptor.durableBatchId);
          setBatchSaveRecovery(null);
          return false;
        }
        throw new Error(data?.error || "分段缓存服务暂时不可用，稍后仍可继续保存。");
      }
      const cache = data.cache as SegmentBatchCacheDocumentV2;
      if (
        cache.schemaVersion !== 2
        || cache.durableBatchId !== descriptor.durableBatchId
        || cache.sourceHash !== descriptor.sourceHash
        || (resumeProjectId && cache.projectId && cache.projectId !== resumeProjectId)
        || !Array.isArray(cache.segments)
      ) {
        window.localStorage.removeItem(descriptor.recoveryKey);
        forgetBatchRecoveryPointer(descriptor.durableBatchId);
        setBatchSaveRecovery(null);
        return false;
      }
      let segments = (cache.segments as CachedRenderedEpisode[])
        .filter((segment) => Number.isInteger(Number(segment.episodeIndex)) && segment.result && segment.promptText && segment.sourceText)
        .sort((left, right) => Number(left.episodeIndex) - Number(right.episodeIndex));
      const stateByIndex = new Map(cache.segmentStates.map((state) => [state.index, { ...state }]));

      const leaseStorageKey = buildSegmentBatchLeaseOwnerKey(descriptor.durableBatchId);
      let leaseOwnerId = window.sessionStorage.getItem(leaseStorageKey) || "";
      if (!leaseOwnerId) {
        leaseOwnerId = typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        window.sessionStorage.setItem(leaseStorageKey, leaseOwnerId);
      }
      if (
        cache.leaseOwnerId
        && cache.leaseOwnerId !== leaseOwnerId
        && Number.isFinite(Date.parse(cache.leaseExpiresAt || ""))
        && Date.parse(cache.leaseExpiresAt || "") > Date.now()
      ) {
        throw new Error("该批次正在另一个标签页继续保存，请勿重复操作。");
      }

      let activeProjectId = cache.projectId || resumeProjectId || "";
      const recoveryIndexKeys = new Set(buildSegmentBatchRecoveryKeys({
        projectId: activeProjectId || null,
        sourceHash: descriptor.sourceHash,
        mode: cache.mode || segmentCountMode,
        requestedCount: cache.requestedCount ?? (segmentCountMode === "auto" ? null : episodeCount),
        duration: cache.duration || selectedDurationValue(),
      }));
      recoveryIndexKeys.add(descriptor.recoveryKey);
      const invocationLedger = createBatchInvocationLedger(cache.invocationEvents || []);
      const completed: BatchPromptSection[] = [];
      let latestSave: ProjectSaveState | null = null;
      let totalSaveMs = 0;

      const persistRecoveryCache = async () => {
        cache.revision += 1;
        cache.projectId = activeProjectId || null;
        cache.updatedAt = new Date().toISOString();
        cache.segmentStates = [...stateByIndex.values()].sort((left, right) => left.index - right.index);
        cache.leaseOwnerId = leaseOwnerId;
        cache.leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        cache.invocationEvents = invocationLedger.summary().events;
        const putResponse = await fetch(`/api/segment-batch-cache/${encodeURIComponent(descriptor.durableBatchId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cache),
        });
        const putData = await putResponse.json().catch(() => null);
        if (!putResponse.ok || !putData?.ok) throw new Error(putData?.error || "服务端分段缓存写入失败");
        const activeRecoveryKey = buildSegmentBatchRecoveryKey({
          projectId: activeProjectId || null,
          sourceHash: descriptor.sourceHash,
          mode: cache.mode || segmentCountMode,
          requestedCount: cache.requestedCount ?? (segmentCountMode === "auto" ? null : episodeCount),
          duration: cache.duration || selectedDurationValue(),
        });
        recoveryIndexKeys.add(activeRecoveryKey);
        const recoveryIndex = JSON.stringify({
          durableBatchId: descriptor.durableBatchId,
          projectId: activeProjectId || null,
          sourceHash: descriptor.sourceHash,
          mode: cache.mode,
          requestedCount: cache.requestedCount,
          duration: cache.duration,
          updatedAt: cache.updatedAt,
        });
        for (const recoveryKey of recoveryIndexKeys) {
          window.localStorage.setItem(recoveryKey, recoveryIndex);
        }
        rememberBatchRecoveryPointer({
          schemaVersion: 1,
          durableBatchId: descriptor.durableBatchId,
          recoveryKey: activeRecoveryKey,
          sourceHash: descriptor.sourceHash,
          projectId: activeProjectId || null,
          updatedAt: cache.updatedAt,
        });
      };

      const publishSaveOnlyProgress = (message: string) => {
        const states = [...stateByIndex.values()].sort((left, right) => left.index - right.index);
        const summary = summarizeBatchSegmentProgress(
          states.map((state) => ({ index: state.index, status: progressStatusFromSegmentState(state) })),
          cache.resolvedSegmentCount,
        );
        const invocationMetrics = invocationLedger.summary();
        setBatchProgress({
          mode: cache.mode || segmentCountMode,
          phase: summary.isSettled ? summary.terminalPhase || "completed" : "saving",
          requestedCount: cache.requestedCount ?? (segmentCountMode === "auto" ? null : episodeCount),
          resolvedSegmentCount: cache.resolvedSegmentCount,
          startedAtMs,
          updatedAtMs: Date.now(),
          finishedAtMs: summary.isSettled ? Date.now() : undefined,
          elapsedMs: Math.max(0, Date.now() - startedAtMs),
          completedCount: summary.savedCount,
          savedCount: summary.savedCount,
          cachedCount: summary.cachedCount,
          runningCount: 0,
          pendingCount: summary.pendingCount,
          repairingCount: 0,
          adjudicatingCount: 0,
          needsReviewCount: summary.needsReviewCount,
          savingCount: summary.savingCount,
          currentMessage: message,
          segments: states.map((state) => ({
            index: state.index,
            status: progressStatusFromSegmentState(state),
            message: state.message,
          })),
          qualityReportSummary: summarizeSegmentQualityReports(cache.qualityReports as SegmentQualityReport[]),
          invocationMetrics: {
            renderPackCalls: invocationMetrics.renderPackCalls,
            singleRegenerationCalls: invocationMetrics.singleRegenerationCalls,
            pathPatchJobCreated: invocationMetrics.pathPatchJobCreated,
            pathPatchCompleted: invocationMetrics.pathPatchCompleted,
            judgeCalls: invocationMetrics.judgeCalls,
            localPatchOperations: invocationMetrics.localPatchOperations,
          },
          timingMetrics: {
            renderWallMs: 0,
            repairWaitMs: 0,
            saveMs: totalSaveMs,
            criticalPathMs: Math.max(0, Date.now() - startedAtMs),
          },
        });
        setGenerationProgress(message);
      };

      const retainRecoveryPointer = await resumeCachedRenderOperations({
        cache,
        stateByIndex,
        persist: persistRecoveryCache,
      });
      segments = (cache.segments as CachedRenderedEpisode[])
        .filter((segment) => Number.isInteger(Number(segment.episodeIndex)) && segment.result && segment.promptText && segment.sourceText)
        .sort((left, right) => Number(left.episodeIndex) - Number(right.episodeIndex));
      const unsaved = segments.filter((segment) => {
        const state = stateByIndex.get(Number(segment.episodeIndex));
        return state?.saveStatus !== "saved" && state?.saveStatus !== "review_saved";
      });
      if (!unsaved.length) {
        if (retainRecoveryPointer) {
          await persistRecoveryCache();
          publishSaveOnlyProgress("已恢复原 Render Pack 观察，等待原任务完成，不会创建新的生成任务。");
          setBatchGenerating(false);
          return true;
        }
        window.localStorage.removeItem(descriptor.recoveryKey);
        forgetBatchRecoveryPointer(descriptor.durableBatchId);
        setBatchSaveRecovery(null);
        setBatchGenerating(false);
        return false;
      }

      publishSaveOnlyProgress(`检测到 ${unsaved.length} 段已生成结果，仅继续保存，不会调用模型。`);
      for (const segment of segments) {
        const segmentIndex = Number(segment.episodeIndex);
        let state = stateByIndex.get(segmentIndex) || createInitialSegmentStates(cache.resolvedSegmentCount)[segmentIndex - 1];
        if (!state || state.saveStatus === "saved" || state.saveStatus === "review_saved") {
          if (segment.result && segment.sourceText && segment.promptText) {
            completed.push({
              segment: { index: segmentIndex, text: segment.sourceText },
              result: segment.result,
              promptText: segment.promptText,
            });
          }
          continue;
        }
        const dispatch = (event: SegmentStateEvent) => {
          const next = reduceSegmentState(state, { ...event, baseRevision: state.revision });
          state = next;
          stateByIndex.set(segmentIndex, next);
        };
        if (!state.resultHash && segment.result) {
          dispatch({ type: "RENDER_SUCCEEDED", resultHash: buildBatchSegmentResultHash(segment.result) });
        }
        if (state.qualityStatus === "unknown") {
          dispatch(segment.status === "needs_review" || segment.status === "review_saved"
            ? { type: "QUALITY_NEEDS_REVIEW", message: "恢复待检查结果" }
            : { type: "QUALITY_PASSED" });
        }
        if (state.saveStatus === "not_ready") dispatch({ type: "CACHE_READY" });
        if (state.saveStatus === "save_failed") dispatch({ type: "SAVE_RESUMED" });
        dispatch({ type: "SAVE_STARTED" });
        publishSaveOnlyProgress(`正在仅保存第 ${segmentIndex} / ${cache.resolvedSegmentCount} 段...`);
        const saveStartedAt = Date.now();
        let save: ProjectSaveState = { saved: false, retryable: true, errorCode: "PROJECT_API_UNAVAILABLE" };
        const retryDelays = [1_000, 3_000, 8_000] as const;
        for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
          save = await saveAnalysisProject(
            segment.sourceText || "",
            segment.result as AnalysisResult,
            segment.promptText || "",
            activeProjectId || undefined,
            undefined,
            `${descriptor.durableBatchId}:${segmentIndex}`,
            state.qualityStatus === "needs_review" ? "needs_review" : "draft",
          );
          if (save.saved || !save.retryable || attempt >= retryDelays.length) break;
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        }
        totalSaveMs += Math.max(0, Date.now() - saveStartedAt);
        if (!save.saved || !save.projectId || !save.versionId || !save.versionNumber) {
          dispatch({
            type: "SAVE_FAILED",
            errorCode: save.errorCode || "PROJECT_API_UNAVAILABLE",
            message: save.message || save.reason || "项目保存失败",
          });
          await persistRecoveryCache();
          publishSaveOnlyProgress(`第 ${segmentIndex} 段保存失败，已保留完整缓存，可稍后继续保存。`);
          setError(save.message || save.reason || "项目保存失败");
          setBatchGenerating(false);
          return true;
        }
        activeProjectId = save.projectId;
        latestSave = save;
        const reviewSave = state.qualityStatus === "needs_review";
        dispatch({ type: "SAVE_SUCCEEDED", review: reviewSave });
        segment.status = reviewSave ? "review_saved" : "saved";
        completed.push({
          segment: { index: segmentIndex, text: segment.sourceText || "" },
          result: segment.result as AnalysisResult,
          promptText: segment.promptText || "",
        });
        const reportIndex = (cache.qualityReports as SegmentQualityReport[])
          .findIndex((report) => report.segmentIndex === segmentIndex);
        if (reportIndex >= 0) {
          const report = (cache.qualityReports as SegmentQualityReport[])[reportIndex];
          (cache.qualityReports as SegmentQualityReport[])[reportIndex] = updateSegmentQualityReportStatus(
            report,
            state.qualityStatus === "needs_review" ? "needs_review" : "saved",
          );
        }
        await persistRecoveryCache();
      }

      setBatchResults(completed.sort((left, right) => left.segment.index - right.segment.index));
      const last = completed.at(-1);
      if (last) setResult(last.result);
      if (latestSave) {
        setProjectSave(latestSave);
        if (latestSave.projectId) setResumeProjectId(latestSave.projectId);
        if (latestSave.versionId) setResumeVersionId(latestSave.versionId);
      }
      const keepRecoveryPointer = shouldRetainRenderRecoveryPointer({
        operations: cache.renderOperations || [],
        segmentStates: [...stateByIndex.values()],
      });
      if (!keepRecoveryPointer) {
        for (const recoveryKey of recoveryIndexKeys) window.localStorage.removeItem(recoveryKey);
        forgetBatchRecoveryPointer(descriptor.durableBatchId);
        window.sessionStorage.removeItem(leaseStorageKey);
        setBatchSaveRecovery(null);
      }
      publishSaveOnlyProgress(keepRecoveryPointer
        ? `已保存当前可用的 ${completed.length} 段，仍在观察原 Render Pack，不会创建补生成任务。`
        : `已仅继续保存 ${completed.length} / ${cache.resolvedSegmentCount} 段，模型调用增量为 0。`);
      setBatchGenerating(false);
      return true;
    } catch (resumeError) {
      const message = formatUserFacingError(resumeError, "继续保存缓存失败");
      setError(message);
      setGenerationProgress(message);
      setBatchGenerating(false);
      return true;
    }
  }

  async function runBatchEpisodeGeneration() {
    const recoveryDiscovery = batchSaveRecovery
      ? { status: "recoverable", descriptor: batchSaveRecovery } as const
      : await ensureBatchSaveRecoveryDiscovery();
    if (recoveryDiscovery.status === "unavailable") {
      setError(recoveryDiscovery.message);
      setGenerationProgress(recoveryDiscovery.message);
      return;
    }
    if (
      recoveryDiscovery.status === "recoverable"
      && await resumeCachedBatchSavesOnly(recoveryDiscovery.descriptor)
    ) return;
    const completed: BatchPromptSection[] = [];
    let activeProjectId = resumeProjectId || "";
    const latestSaveRef: { current: ProjectSaveState | null } = { current: null };
    const mode = segmentCountMode;
    const requestedCount = mode === "auto" ? null : episodeCount;
    const requestedDuration = selectedDurationValue();
    const batchSourceHash = buildBatchSegmentResultHash({
      mode,
      episodeCount,
      duration: requestedDuration,
      sourceText: script,
    });
    let batchProjectId = activeProjectId || null;
    const batchRecoveryKey = buildSegmentBatchRecoveryKey({
      projectId: batchProjectId,
      sourceHash: batchSourceHash,
      mode,
      requestedCount,
      duration: requestedDuration,
    });
    const batchRecoveryIndexKeys = new Set([batchRecoveryKey]);
    let resolvedSegmentCount = requestedCount || null;
    let segmentProgressItems: BatchSegmentProgress[] = [];
    let segmentStateRecords: SegmentStateRecord[] = [];
    const qualityReports = new Map<number, SegmentQualityReport>();
    const invocationLedger = createBatchInvocationLedger();
    const batchStartedAtMs = Date.now();
    let renderPhaseStartedAtMs = 0;
    let renderPhaseFinishedAtMs = 0;
    let repairFirstQueuedAtMs = 0;
    let repairFinishedAtMs = 0;
    let totalSaveDurationMs = 0;
    let batchFinishedAtMs: number | undefined;
    let currentBatchPhase: BatchGenerationPhase = "planning";
    setBatchGenerating(true);

    function qualityReportSummary() {
      return summarizeSegmentQualityReports(Array.from(qualityReports.values()));
    }

    function publishBatchProgress(phase: BatchGenerationPhase, currentMessage: string) {
      const nowMs = Date.now();
      const summary = summarizeBatchSegmentProgress(segmentProgressItems, resolvedSegmentCount);
      const savedCount = summary.savedCount;
      const cachedCount = summary.cachedCount;
      const completedCount = savedCount;
      const runningCount = summary.runningCount;
      const repairingCount = summary.repairingCount;
      const adjudicatingCount = summary.adjudicatingCount;
      const needsReviewCount = summary.needsReviewCount;
      const savingCount = summary.savingCount;
      const pendingCount = summary.pendingCount;
      const derivedPhase = segmentStateRecords.length && phase !== "planning"
        ? deriveBatchPhaseFromSegmentStates(segmentStateRecords)
        : null;
      const normalizedPhase = phase === "failed" || phase === "quota_paused"
        ? phase
        : derivedPhase || resolveBatchGenerationPhase(phase, summary);
      const normalizedMessage = summary.isSettled
        ? needsReviewCount > 0
          ? `已保存 ${savedCount} / ${resolvedSegmentCount} 段，其中 ${needsReviewCount} 段待检查。`
          : `已保存第 ${savedCount} / ${resolvedSegmentCount} 段。`
        : currentMessage;
      currentBatchPhase = normalizedPhase;

      if (["completed", "failed", "needs_review", "quota_paused"].includes(normalizedPhase) && !batchFinishedAtMs) {
        batchFinishedAtMs = nowMs;
      }
      if (normalizedPhase === "completed") {
        setError("");
        setBatchGenerating(false);
      }
      if (normalizedPhase === "needs_review" || normalizedPhase === "quota_paused") setBatchGenerating(false);
      const elapsedReferenceMs = batchFinishedAtMs || nowMs;
      const invocationMetrics = invocationLedger.summary();
      setBatchProgress({
        mode,
        phase: normalizedPhase,
        requestedCount,
        resolvedSegmentCount,
        startedAtMs: batchStartedAtMs,
        updatedAtMs: nowMs,
        finishedAtMs: batchFinishedAtMs,
        elapsedMs: Math.max(0, elapsedReferenceMs - batchStartedAtMs),
        completedCount,
        savedCount,
        cachedCount,
        runningCount,
        pendingCount,
        repairingCount,
        adjudicatingCount,
        needsReviewCount,
        savingCount,
        currentMessage: normalizedMessage,
        segments: segmentProgressItems,
        qualityReportSummary: qualityReportSummary(),
        invocationMetrics: {
          renderPackCalls: invocationMetrics.renderPackCalls,
          singleRegenerationCalls: invocationMetrics.singleRegenerationCalls,
          pathPatchJobCreated: invocationMetrics.pathPatchJobCreated,
          pathPatchCompleted: invocationMetrics.pathPatchCompleted,
          judgeCalls: invocationMetrics.judgeCalls,
          localPatchOperations: invocationMetrics.localPatchOperations,
        },
        timingMetrics: {
          renderWallMs: renderPhaseStartedAtMs
            ? Math.max(0, (renderPhaseFinishedAtMs || nowMs) - renderPhaseStartedAtMs)
            : 0,
          repairWaitMs: repairFirstQueuedAtMs
            ? Math.max(0, (repairFinishedAtMs || nowMs) - repairFirstQueuedAtMs)
            : 0,
          saveMs: totalSaveDurationMs,
          criticalPathMs: Math.max(0, elapsedReferenceMs - batchStartedAtMs),
        },
      });
      setGenerationProgress(normalizedMessage);
    }

    function rebuildSegmentProgressFromState() {
      segmentProgressItems = segmentStateRecords.map((state) => {
        const existing = segmentProgressItems.find((item) => item.index === state.index);
        return {
          index: state.index,
          title: existing?.title || episodes?.find((episode) => episode.episodeIndex === state.index)?.input.title,
          status: progressStatusFromSegmentState(state),
          message: state.message,
        };
      });
    }

    function dispatchSegmentStateEvent(index: number, event: SegmentStateEvent) {
      const effectiveEvent: SegmentStateEvent = !TASK_ONE_STATE_REDUCER_ENABLED && event.type === "QUALITY_BLOCKED"
        ? {
            type: "QUALITY_NEEDS_REVIEW",
            message: event.message,
            baseRevision: event.baseRevision,
            at: event.at,
          }
        : event;
      segmentStateRecords = segmentStateRecords.map((item) => (
        item.index === index ? reduceSegmentState(item, effectiveEvent) : item
      ));
      const state = segmentStateRecords.find((item) => item.index === index);
      const report = qualityReports.get(index);
      if (state && report) {
        qualityReports.set(index, updateSegmentQualityReportStatus(
          report,
          segmentQualityReportStatusFromState(state, report.status),
        ));
      }
      rebuildSegmentProgressFromState();
    }

    type RenderOperation = {
      segmentIndex: number;
      token: string;
    };

    type RepairOperationIdentity = {
      segmentIndex: number;
      resultHash?: string;
      repairFingerprint?: string;
      jobId?: string;
      contractHash?: string;
    };

    let segmentOperationSequence = 0;
    const activeRenderOperations = new Map<number, RenderOperation>();

    function beginRenderOperation(segmentIndex: number, token?: string): RenderOperation {
      const operation = {
        segmentIndex,
        token: token || `render:${segmentIndex}:${++segmentOperationSequence}`,
      };
      activeRenderOperations.set(segmentIndex, operation);
      return operation;
    }

    function isCurrentRenderOperation(operation: RenderOperation | null | undefined) {
      if (!operation) return false;
      return activeRenderOperations.get(operation.segmentIndex)?.token === operation.token;
    }

    function finishRenderOperation(operation: RenderOperation | null | undefined) {
      if (operation && isCurrentRenderOperation(operation)) {
        activeRenderOperations.delete(operation.segmentIndex);
      }
    }

    function replaceRenderOperationRecord(operation: RenderOperationRefV2) {
      renderOperationRecords = retainBoundedRenderOperationAudits([
        ...renderOperationRecords.filter((item) => item.operationToken !== operation.operationToken),
        operation,
      ]);
    }

    function captureRepairOperationIdentity(segmentIndex: number): RepairOperationIdentity | null {
      const state = segmentStateRecords.find((item) => item.index === segmentIndex);
      if (!state) return null;
      return {
        segmentIndex,
        resultHash: state.resultHash,
        repairFingerprint: state.repairFingerprint,
        jobId: state.activeRepairJobId,
        contractHash: state.contractHash,
      };
    }

    function isCurrentRepairOperation(identity: RepairOperationIdentity | null) {
      if (!identity) return false;
      const state = segmentStateRecords.find((item) => item.index === identity.segmentIndex);
      return Boolean(
        state
        && state.resultHash === identity.resultHash
        && state.repairFingerprint === identity.repairFingerprint
        && state.contractHash === identity.contractHash
        && (!identity.jobId || state.activeRepairJobId === identity.jobId),
      );
    }

    function dispatchCurrentRepairEvent(
      identity: RepairOperationIdentity | null,
      event: SegmentStateEvent,
    ) {
      if (!identity || !isCurrentRepairOperation(identity)) return false;
      const before = segmentStateRecords.find((item) => item.index === identity.segmentIndex);
      dispatchSegmentStateEvent(identity.segmentIndex, event);
      const after = segmentStateRecords.find((item) => item.index === identity.segmentIndex);
      return Boolean(before && after && after.revision === before.revision + 1);
    }

    function updateSegmentProgress(index: number, status: BatchSegmentStatus, message?: string) {
      const current = segmentStateRecords.find((item) => item.index === index);
      if (current) {
        dispatchSegmentStateEvent(index, { type: "PROGRESS_UPDATED", status, message });
        rebuildSegmentProgressFromState();
        return;
      }
      segmentProgressItems = segmentProgressItems.map((item) => item.index === index ? { ...item, status, message } : item);
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
    const batchEventFeatures: BatchEventFeatureSnapshot = seasonPackJob.featureFlags || {
      contractV2: true,
      coverageSidecar: true,
      coverageStage: "shadow",
      emergencyStop: false,
      localGate: false,
      judge: false,
      coveragePolicyVersion: DEFAULT_COVERAGE_POLICY_VERSION,
      capturedAt: new Date().toISOString(),
    };
    const batchCoverageStage: BatchEventCoverageStage = batchEventFeatures.coverageStage;
    const batchCoverageMode = batchEventFeatures.contractV2 && coverageStageUsesLocalGate(batchCoverageStage)
      ? "active" as const
      : "shadow" as const;
    const episodes = [...(seasonPackJob.result?.episodes || [])].sort((left, right) => left.episodeIndex - right.episodeIndex);
    resolvedSegmentCount = episodes.length;
    const batchContractHash = buildStableBatchContractHash(
      episodes.map((episode) => ({
        segmentIndex: episode.episodeIndex,
        contractHash: episode.input.segmentContract?.contractHash || buildBatchSegmentResultHash(episode.input.sourceText),
      })),
    );
    const batchCacheKey = batchRecoveryKey;
    let durableBatchId = seasonPackJob.id;
    if (typeof window !== "undefined") {
      try {
        const rawBatchIndex = window.localStorage.getItem(batchCacheKey);
        const batchIndex = rawBatchIndex ? JSON.parse(rawBatchIndex) as Record<string, unknown> : null;
        if (
          batchIndex
          && batchIndex.sourceHash === batchSourceHash
          && batchIndex.contractHash === batchContractHash
          && batchIndex.resolvedSegmentCount === resolvedSegmentCount
          && (batchProjectId === null || batchIndex.projectId === batchProjectId)
          && (
            typeof batchIndex.durableBatchId === "string"
            || typeof batchIndex.batchId === "string"
          )
        ) {
          durableBatchId = typeof batchIndex.durableBatchId === "string"
            ? batchIndex.durableBatchId
            : String(batchIndex.batchId);
        }
      } catch (cacheIndexError) {
        console.warn("Failed to read lightweight batch cache index", cacheIndexError);
      }
    }
    const leaseStorageKey = buildSegmentBatchLeaseOwnerKey(durableBatchId);
    let durableBatchLeaseOwnerId = typeof window !== "undefined"
      ? window.sessionStorage.getItem(leaseStorageKey) || ""
      : "";
    if (!durableBatchLeaseOwnerId) {
      durableBatchLeaseOwnerId = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (typeof window !== "undefined") window.sessionStorage.setItem(leaseStorageKey, durableBatchLeaseOwnerId);
    }
    function clearBatchRecoveryState() {
      if (typeof window === "undefined") return;
      for (const recoveryKey of batchRecoveryIndexKeys) window.localStorage.removeItem(recoveryKey);
      forgetBatchRecoveryPointer(durableBatchId);
      window.sessionStorage.removeItem(leaseStorageKey);
      setBatchSaveRecovery(null);
    }
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
    segmentStateRecords = createInitialSegmentStates(
      resolvedSegmentCount,
      new Map(episodes.map((episode) => [
        episode.episodeIndex,
        episode.input.segmentContract?.contractHash || batchContractHash,
      ])),
    );
    publishBatchProgress("rendering", `已识别 ${resolvedSegmentCount} 段，正在按单段质量逐段生成...`);

    type RenderedEpisode = {
      episodeIndex: number;
      episodeInput: SeasonPackEpisodeInput;
      result: AnalysisResult;
      promptText: string;
      sourceText: string;
    };

    type PendingCoverageJudgeSegment = {
      episode: SeasonPackEpisodeResult;
      result: AnalysisResult;
      renderDuration: string;
      renderStartedAt: number;
      renderCompletedAt: number;
      packIndex?: number;
      packSize: number;
      sidecar?: SegmentCoverageSidecar | null;
      localDecisions: CoverageDecision[];
    };

    const renderedEpisodes: Array<RenderedEpisode | undefined> = new Array(resolvedSegmentCount);
    type RepairQueueItem = {
      episode: SeasonPackEpisodeResult;
      reason: string;
      reasonType: BatchRepairReasonType;
      existingResult?: AnalysisResult;
      validationError?: unknown;
      renderDuration?: string;
      renderStartedAt?: number;
      packIndex?: number;
      packSize?: number;
    };
    let repairScheduler: ReturnType<typeof createBatchRepairScheduler<RepairQueueItem, void>>;
    const queuedRepairIndexes = new Set<number>();
    const repairAttemptCounts = new Map<string, number>();
    const segmentRepairReasons = new Map<number, string[]>();
    const needsReviewEpisodes = new Map<number, { result: AnalysisResult; reason: string }>();
    let batchCachePersistChain = Promise.resolve();
    let batchCacheRevision = 0;
    let batchCacheWriteError: Error | null = null;
    let saveError: Error | null = null;
    let renderOperationRecords: RenderOperationRefV2[] = [];
    const mergedRepairJobIds = new Set<string>();
    let activeRenderScheduleProfile = "UNSCHEDULED";
    let batchQuotaPaused = false;
    let batchQuotaPauseMessage = "";

    function pauseBatchForCodexQuota(segmentIndexes: number[], error: unknown) {
      batchQuotaPaused = true;
      batchQuotaPauseMessage = formatUserFacingError(error, CODEX_QUOTA_EXHAUSTED_DISPLAY_MESSAGE);
      for (const episodeIndex of segmentIndexes) {
        const current = segmentProgressItems.find((item) => item.index === episodeIndex);
        if (current?.status === "saved" || current?.status === "cached") continue;
        updateSegmentProgress(episodeIndex, "quota_paused", batchQuotaPauseMessage);
      }
      writeBatchSegmentCache();
      publishBatchProgress("quota_paused", `${batchQuotaPauseMessage} 已保留全部已生成结果，恢复额度后可继续。`);
    }

    function registerSegmentRepairReason(episodeIndex: number, reason: string) {
      const current = segmentRepairReasons.get(episodeIndex) || [];
      if (!current.includes(reason)) {
        segmentRepairReasons.set(episodeIndex, [...current, reason]);
      }
    }

    function markSegmentQualityStatus(
      episodeIndex: number,
      status: SegmentQualityStatus,
      patch: Partial<Pick<SegmentQualityReport, "durationMs" | "repairCount" | "repairReasons" | "qualityScore" | "qualityFindings" | "safetyRisk" | "safetyFindings">> = {},
    ) {
      const existing = qualityReports.get(episodeIndex);
      if (!existing) return;
      qualityReports.set(episodeIndex, updateSegmentQualityReportStatus(existing, status, patch));
    }

    function writeBatchSegmentCache() {
      if (typeof window === "undefined") return batchCachePersistChain;
      const cachedSegments = renderedEpisodes
        .filter((item): item is RenderedEpisode => Boolean(item))
        .sort((left, right) => left.episodeIndex - right.episodeIndex)
        .map((item) => ({
          episodeIndex: item.episodeIndex,
          title: item.result.title,
          sourceText: item.sourceText,
          promptText: item.promptText,
          result: item.result,
          status: (() => {
            const state = segmentStateRecords.find((candidate) => candidate.index === item.episodeIndex);
            if (state?.saveStatus === "review_saved") return "review_saved";
            if (state?.saveStatus === "saved") return "saved";
            if (state?.qualityStatus === "needs_review") return "needs_review";
            return qualityReports.get(item.episodeIndex)?.status || "cached";
          })(),
          cachedAt: new Date().toISOString(),
        }));
      const updatedAt = new Date().toISOString();
      batchCacheRevision += 1;
      const cacheDocument: SegmentBatchCacheDocumentV2 = {
        schemaVersion: 2 as const,
        revision: batchCacheRevision,
        batchId: durableBatchId,
        durableBatchId,
        projectId: batchProjectId,
        sourceHash: batchSourceHash,
        contractHash: batchContractHash,
        resolvedSegmentCount: resolvedSegmentCount || episodes.length,
        qualityReports: Array.from(qualityReports.values()),
        needsReviewSegments: Array.from(needsReviewEpisodes.entries()).map(([episodeIndex, item]) => ({
          episodeIndex,
          reason: item.reason,
          result: item.result,
        })),
        updatedAt,
        phase: currentBatchPhase,
        segmentStates: segmentStateRecords,
        activeJobIds: Array.from(new Set([
          ...segmentStateRecords.map((item) => item.activeRepairJobId),
          ...renderOperationRecords
            .filter((operation) => ["creating", "observing", "detached"].includes(operation.state))
            .map((operation) => operation.jobId),
        ].filter((value): value is string => Boolean(value)))),
        coverageStage: batchCoverageStage,
        renderRound: 1,
        repairAttempts: Array.from(repairAttemptCounts.entries()),
        leaseOwnerId: durableBatchLeaseOwnerId,
        leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        mode,
        requestedCount,
        duration: requestedDuration,
        invocationEvents: invocationLedger.summary().events,
        renderOperations: retainBoundedRenderOperationAudits(renderOperationRecords),
        segments: cachedSegments,
      };
      try {
        const activeRecoveryKey = buildSegmentBatchRecoveryKey({
          projectId: batchProjectId,
          sourceHash: batchSourceHash,
          mode,
          requestedCount,
          duration: requestedDuration,
        });
        batchRecoveryIndexKeys.add(activeRecoveryKey);
        const recoveryIndex = JSON.stringify({
          durableBatchId,
          projectId: batchProjectId,
          sourceHash: batchSourceHash,
          contractHash: batchContractHash,
          resolvedSegmentCount,
          cachedCount: cachedSegments.length,
          revision: batchCacheRevision,
          mode,
          requestedCount,
          duration: requestedDuration,
          updatedAt,
        });
        for (const recoveryKey of batchRecoveryIndexKeys) {
          window.localStorage.setItem(recoveryKey, recoveryIndex);
        }
        rememberBatchRecoveryPointer({
          schemaVersion: 1,
          durableBatchId,
          recoveryKey: activeRecoveryKey,
          sourceHash: batchSourceHash,
          projectId: batchProjectId,
          updatedAt,
        });
      } catch (cacheError) {
        console.warn("Failed to write lightweight batch cache index", cacheError);
      }
      batchCachePersistChain = batchCachePersistChain
        .catch(() => undefined)
        .then(async () => {
          const response = await fetch(`/api/segment-batch-cache/${encodeURIComponent(durableBatchId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cacheDocument),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.ok) throw new Error(data?.error || "服务端分段缓存写入失败");
          batchCacheWriteError = null;
        })
        .catch((cacheError) => {
          batchCacheWriteError = cacheError instanceof Error ? cacheError : new Error("服务端分段缓存写入失败");
          setGenerationProgress(`${batchCacheWriteError.message}，已保留浏览器恢复索引。`);
        });
      return batchCachePersistChain;
    }

    async function watchDetachedRepair(
      episode: SeasonPackEpisodeResult,
      originalResult: AnalysisResult,
      renderDuration: string,
      repairIdentity: { jobId: string; contractHash: string; resultHash: string },
      detachedAt = Date.now(),
    ) {
      try {
        while (shouldContinueDetachedRepairObservation({ detachedAt, now: Date.now() })) {
          const queryIdentity = captureRepairOperationIdentity(episode.episodeIndex);
          if (queryIdentity?.jobId !== repairIdentity.jobId) return;
          const repairJob = await queryBatchSegmentRepairCodexJob(repairIdentity.jobId);
          if (!isCurrentRepairOperation(queryIdentity)) {
            const current = captureRepairOperationIdentity(episode.episodeIndex);
            if (current?.jobId !== repairIdentity.jobId) return;
            continue;
          }
          if (repairJob.status === "pending" || repairJob.status === "running") {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            continue;
          }
          if (repairJob.status === "failed") {
            dispatchCurrentRepairEvent(queryIdentity, {
              type: "REPAIR_FAILED",
              jobId: repairIdentity.jobId,
              errorCode: "REPAIR_JOB_FAILED",
              message: repairJob.error || "后台路径修复失败，已保留首次结果",
            });
            writeBatchSegmentCache();
            return;
          }
          const currentState = segmentStateRecords.find((state) => state.index === episode.episodeIndex);
          const currentRendered = renderedEpisodes[episode.episodeIndex - 1];
          const currentResult = currentRendered?.result || originalResult;
          const decision = decideLateRepairMerge({
            jobId: repairIdentity.jobId,
            activeRepairJobId: currentState?.activeRepairJobId,
            jobStatus: repairJob.status,
            expectedContractHash: repairIdentity.contractHash,
            currentContractHash: currentState?.contractHash || episode.input.segmentContract?.contractHash,
            expectedResultHash: repairIdentity.resultHash,
            currentResultHash: buildBatchSegmentResultHash(currentResult),
            mergedJobIds: mergedRepairJobIds,
            saveStatus: currentState?.saveStatus || "not_ready",
          });
          if (decision.action === "continue_polling") {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            continue;
          }
          if (decision.action === "late_patch_available") {
            if (!dispatchCurrentRepairEvent(queryIdentity, {
              type: "LATE_PATCH_AVAILABLE",
              jobId: repairIdentity.jobId,
            })) return;
            updateSegmentProgress(episode.episodeIndex, currentState?.saveStatus === "saved" ? "saved" : "review_saved", "后台修复已完成，可人工确认晚到补丁；不会静默修改已保存项目");
            writeBatchSegmentCache();
            return;
          }
          if (decision.action === "archive_stale" || decision.action === "ignore_duplicate") {
            if (decision.action === "archive_stale") {
              dispatchCurrentRepairEvent(queryIdentity, {
                type: "REPAIR_FAILED",
                jobId: repairIdentity.jobId,
                errorCode: "STALE_REPAIR_RESULT",
                message: "后台修复结果与当前版本不一致，已归档且未覆盖提示词",
              });
            }
            writeBatchSegmentCache();
            return;
          }
          if (!repairJob.result) {
            dispatchCurrentRepairEvent(queryIdentity, {
              type: "REPAIR_FAILED",
              jobId: repairIdentity.jobId,
              errorCode: "EMPTY_REPAIR_PATCH",
              message: "后台修复完成但没有有效补丁，已保留首次结果",
            });
            writeBatchSegmentCache();
            return;
          }
          const repairedResult = applyBatchSegmentRepairPatch(currentResult, repairJob.result);
          assertBatchSegmentRepairPatchIsolation(
            currentResult,
            repairedResult,
            repairJob.result.repairs.map((repair) => repair.path),
          );
          const validated = normalizePatchAndValidateBatchSegment(
            script,
            episode.episodeIndex,
            repairedResult,
            renderDuration,
            episode.input.segmentContract,
            undefined,
            undefined,
            batchCoverageMode,
          );
          if (!dispatchCurrentRepairEvent(queryIdentity, {
            type: "REPAIR_COMPLETED",
            jobId: repairIdentity.jobId,
            resultHash: buildBatchSegmentResultHash(validated.result),
          })) return;
          mergedRepairJobIds.add(repairIdentity.jobId);
          invocationLedger.record("pathPatchCompleted", { segmentIndex: episode.episodeIndex });
          needsReviewEpisodes.delete(episode.episodeIndex);
          storeRenderedEpisode(episode, validated.result, {
            status: "repaired",
            qualityGate: validated.gate,
            patchDiffs: validated.patchDiffs,
            codexRepairAttempted: true,
            coverageDecisions: validated.coverageDecisions,
            coverageDurationMs: validated.coverageDurationMs,
          });
          return;
        }
        const timeoutIdentity = captureRepairOperationIdentity(episode.episodeIndex);
        if (timeoutIdentity?.jobId === repairIdentity.jobId) {
          dispatchCurrentRepairEvent(timeoutIdentity, {
            type: "MESSAGE_UPDATED",
            message: "后台修复超过最终观察期限，已停止自动查询；首次结果和原任务标识均已保留。",
          });
        }
        writeBatchSegmentCache();
      } catch (error) {
        const errorIdentity = captureRepairOperationIdentity(episode.episodeIndex);
        if (errorIdentity?.jobId === repairIdentity.jobId) {
          dispatchCurrentRepairEvent(errorIdentity, {
            type: "MESSAGE_UPDATED",
            message: `${formatUserFacingError(error, "后台修复状态读取失败")}；首次结果与任务标识均已保留。`,
          });
        }
        writeBatchSegmentCache();
      }
    }

    async function repairExistingBatchSegment(
      renderScript: string,
      renderDuration: string,
      episodeIndex: number,
      episodeCount: number,
      episodeResult: AnalysisResult,
      segmentContract: SegmentContract | undefined,
      error: unknown,
    ) {
        const reason = error instanceof Error ? error.message : "当前段未通过质量校验";
        const repairFindings = error instanceof BatchSegmentQualityValidationError ? error.findings : [];
        const reasonType = classifyBatchRepairReason(reason);
        const repairLabel = batchRepairReasonLabel(reasonType);
        registerSegmentRepairReason(episodeIndex, reason);
        updateSegmentProgress(episodeIndex, "repairing", `${repairLabel}: ${reason}`);
        publishBatchProgress("repairing", `第 ${episodeIndex} / ${episodeCount} 段正在自动修复：${reason}`);
        let repairIdentity = captureRepairOperationIdentity(episodeIndex);
        const repairRequest = await requestBatchSegmentRepairPatchWithContext({
          projectId: activeProjectId || undefined,
          batchId: seasonPackJob.id,
          segmentIndex: episodeIndex,
          segmentContract,
          sourceText: segmentContract?.sourceText || renderScript,
          failedResult: episodeResult,
          findings: repairFindings,
          onJobCreated: ({ jobId }) => {
            if (!dispatchCurrentRepairEvent(repairIdentity, { type: "REPAIR_STARTED", jobId })) return;
            repairIdentity = captureRepairOperationIdentity(episodeIndex);
            invocationLedger.record("pathPatchJobCreated", { segmentIndex: episodeIndex });
            writeBatchSegmentCache();
          },
        });
        if (!isCurrentRepairOperation(repairIdentity)) {
          throw new StaleSegmentOperationError(episodeIndex, "repair");
        }
        const activeRepairState = segmentStateRecords.find((state) => state.index === episodeIndex);
        if (activeRepairState?.generationStatus === "repair_pending") {
          if (!dispatchCurrentRepairEvent(repairIdentity, {
            type: "REPAIR_STARTED",
            jobId: repairRequest.jobId,
          })) {
            throw new StaleSegmentOperationError(episodeIndex, "repair");
          }
          repairIdentity = captureRepairOperationIdentity(episodeIndex);
          invocationLedger.record("pathPatchJobCreated", { segmentIndex: episodeIndex });
          writeBatchSegmentCache();
        }
        if (repairIdentity?.jobId !== repairRequest.jobId || !isCurrentRepairOperation(repairIdentity)) {
          throw new StaleSegmentOperationError(episodeIndex, "repair");
        }
        if (repairRequest.detached) {
          if (!dispatchCurrentRepairEvent(repairIdentity, {
            type: "REPAIR_DETACHED",
            jobId: repairRequest.jobId,
            message: "路径级修复仍在后台运行，首次结果将保留并保存为待检查草稿",
          })) {
            throw new StaleSegmentOperationError(episodeIndex, "repair");
          }
          const episode = episodes.find((candidate) => candidate.episodeIndex === episodeIndex);
          if (episode) {
            void watchDetachedRepair(episode, episodeResult, renderDuration, repairRequest);
          }
          writeBatchSegmentCache();
          return {
            detached: true as const,
            result: episodeResult,
            jobId: repairRequest.jobId,
            gate: error instanceof BatchSegmentQualityValidationError ? error.gate : undefined,
            patchDiffs: [] as QualityPatchDiff[],
            codexRepairAttempted: true,
            coverageDecisions: error instanceof BatchSegmentQualityValidationError ? error.coverageDecisions : [],
            coverageDurationMs: 0,
          };
        }
        const repairPatch = repairRequest.patch;
        const acceptedRepairDiffs: QualityPatchDiff[] = repairPatch.repairs.map((repair) => {
          const finding = repairFindings.find(
            (item) => normalizeBatchSegmentRepairPath(item.path) === normalizeBatchSegmentRepairPath(repair.path),
          );
          const before = getBatchSegmentRepairValueAtPath(episodeResult, repair.path);
          return {
            path: repair.path,
            code: finding?.code || "missing_required_field",
            severity: finding?.severity === "risk" ? "risk" : "patchable",
            before,
            after: repair.replacement,
            patchSource: "codex",
            reason: finding?.message || reason,
          };
        });
        const repairedResult = applyBatchSegmentRepairPatch(episodeResult, repairPatch);
        assertBatchSegmentRepairPatchIsolation(
          episodeResult,
          repairedResult,
          repairPatch.repairs.map((repair) => repair.path),
        );
        const validatedRepair = normalizePatchAndValidateBatchSegment(
          script,
          episodeIndex,
          repairedResult,
          renderDuration,
          segmentContract,
          undefined,
          undefined,
          batchCoverageMode,
        );
        if (!dispatchCurrentRepairEvent(repairIdentity, {
          type: "REPAIR_COMPLETED",
          jobId: repairRequest.jobId,
          resultHash: buildBatchSegmentResultHash(validatedRepair.result),
        })) {
          throw new StaleSegmentOperationError(episodeIndex, "repair");
        }
        invocationLedger.record("pathPatchCompleted", { segmentIndex: episodeIndex });
        return {
          detached: false as const,
          result: validatedRepair.result,
          gate: validatedRepair.gate,
          patchDiffs: [...acceptedRepairDiffs, ...validatedRepair.patchDiffs],
          codexRepairAttempted: true,
          coverageDecisions: validatedRepair.coverageDecisions,
          coverageDurationMs: validatedRepair.coverageDurationMs,
        };
    }

    async function renderBatchSegmentWithQualityRepair(
      renderScript: string,
      renderDuration: string,
      episodeIndex: number,
      episodeCount: number,
      segmentContract?: SegmentContract,
      renderOperation?: RenderOperation,
    ) {
      const rawResult = await requestAnalysisWithContext(
        renderScript,
        renderDuration,
        activeProjectId || undefined,
        undefined,
      );
      if (!isCurrentRenderOperation(renderOperation)) {
        throw new StaleSegmentOperationError(episodeIndex, "render");
      }
      const episodeResult = normalizeBatchEpisodeResult(script, episodeIndex, episodeCount, rawResult, renderDuration);
      const evaluated = normalizePatchAndEvaluateBatchSegment(
        script,
        episodeIndex,
        episodeResult,
        renderDuration,
        segmentContract,
        undefined,
        undefined,
        batchCoverageMode,
      );
      const outcome = routeBatchSegmentOutcome({
        gate: evaluated.gate,
        hasUsableResult: true,
        coverageStage: batchCoverageStage,
      });
      if (outcome.action === "accept") {
        legacyFatalCheck(episodeIndex, evaluated.result, evaluated.gate);
        return {
          detached: false as const,
          result: evaluated.result,
          gate: evaluated.gate,
          patchDiffs: evaluated.patchDiffs,
          codexRepairAttempted: false,
          coverageDecisions: evaluated.coverageDecisions,
          coverageDurationMs: evaluated.coverageDurationMs,
        };
      }
      if (outcome.action === "request_quality_patch" || outcome.action === "request_event_patch") {
        const routeError = qualityErrorForRoute(
          evaluated.gate,
          outcome,
          evaluated.result,
          evaluated.coverageDecisions,
        );
        return repairExistingBatchSegment(
          renderScript,
          renderDuration,
          episodeIndex,
          episodeCount,
          evaluated.result,
          segmentContract,
          routeError,
        );
      }
      throw new BatchSegmentQualityValidationError(
        evaluated.gate,
        evaluated.result,
        evaluated.coverageDecisions,
      );
    }

    type SaveOperation = {
      segmentIndex: number;
      token: string;
      idempotencyKey: string;
      resultHash: string;
    };

    const activeSaveOperations = new Map<number, SaveOperation>();

    function beginSaveOperation(segmentIndex: number, resultHash: string): SaveOperation {
      const operation = {
        segmentIndex,
        token: `save:${segmentIndex}:${++segmentOperationSequence}`,
        idempotencyKey: `${durableBatchId}:${segmentIndex}`,
        resultHash,
      };
      activeSaveOperations.set(segmentIndex, operation);
      return operation;
    }

    function isCurrentSaveOperation(operation: SaveOperation | null | undefined) {
      if (!operation) return false;
      const active = activeSaveOperations.get(operation.segmentIndex);
      const state = segmentStateRecords.find((item) => item.index === operation.segmentIndex);
      return Boolean(
        active?.token === operation.token
        && active.idempotencyKey === operation.idempotencyKey
        && state?.resultHash === operation.resultHash
        && state.saveStatus === "saving",
      );
    }

    function finishSaveOperation(operation: SaveOperation | null | undefined) {
      if (operation && activeSaveOperations.get(operation.segmentIndex)?.token === operation.token) {
        activeSaveOperations.delete(operation.segmentIndex);
      }
    }

    const batchSaveController = createResumableBatchSaveController<RenderedEpisode>({
      durableBatchId,
      segmentCount: resolvedSegmentCount,
      saveSegment: async ({ segmentIndex, idempotencyKey, payload, review }): Promise<ResumableBatchSaveResult> => {
        const saveStartedAt = Date.now();
        const episodeIndex = segmentIndex;
        const episodeScript = payload.sourceText;
        const episodeResult = payload.result;
        const fullVideoPrompt = payload.promptText;
        const expectedIdempotencyKey = `${durableBatchId}:${episodeIndex}`;
        if (idempotencyKey !== expectedIdempotencyKey) {
          return {
            saved: false,
            retryable: false,
            errorCode: "PROJECT_VALIDATION_FAILED",
            message: "分段保存幂等键与当前批次不一致",
          };
        }
        const save = await saveAnalysisProject(
          episodeScript,
          episodeResult,
          fullVideoPrompt,
          activeProjectId || undefined,
          undefined,
          `${durableBatchId}:${episodeIndex}`,
          review ? "needs_review" : "draft",
        );
        totalSaveDurationMs += Math.max(0, Date.now() - saveStartedAt);
        if (!save.saved || !save.projectId || !save.versionId || !save.versionNumber) {
          return {
            saved: false,
            retryable: Boolean(save.retryable),
            errorCode: save.errorCode || "PROJECT_API_UNAVAILABLE",
            message: save.message || save.reason || "项目保存失败",
            requestId: save.requestId,
          };
        }

        activeProjectId = save.projectId;
        batchProjectId = save.projectId;
        latestSaveRef.current = save;
        setProjectSave(save);
        setResumeProjectId(save.projectId);
        setResumeVersionId(save.versionId);
        if (!completed.some((item) => item.segment.index === segmentIndex)) {
          completed.push({
            segment: { index: segmentIndex, text: payload.sourceText },
            result: payload.result,
            promptText: payload.promptText,
          });
        }
        setBatchResults([...completed]);
        setResult(payload.result);
        return {
          saved: true,
          projectId: save.projectId,
          versionId: save.versionId,
          versionNumber: save.versionNumber,
          idempotentReplay: save.idempotentReplay,
          requestId: save.requestId,
        };
      },
      onTransition: (entry) => {
        const episodeIndex = entry.segmentIndex;
        if (entry.status === "saving") {
          dispatchSegmentStateEvent(episodeIndex, { type: "SAVE_STARTED" });
          updateSegmentProgress(episodeIndex, "saving", "正在保存到项目");
          const payloadResultHash = entry.payload
            ? buildBatchSegmentResultHash(entry.payload.result)
            : segmentStateRecords.find((item) => item.index === episodeIndex)?.resultHash || "";
          beginSaveOperation(episodeIndex, payloadResultHash);
          publishBatchProgress("saving", `正在保存第 ${episodeIndex} / ${resolvedSegmentCount} 段...`);
          return;
        }
        if (entry.status === "save_failed") {
          const failure = entry.lastResult && !entry.lastResult.saved ? entry.lastResult : null;
          const operation = activeSaveOperations.get(episodeIndex);
          if (!isCurrentSaveOperation(operation)) return;
          dispatchSegmentStateEvent(episodeIndex, {
            type: "SAVE_FAILED",
            errorCode: failure?.errorCode || "PROJECT_API_UNAVAILABLE",
            message: failure?.message || "项目保存失败",
          });
          finishSaveOperation(operation);
          updateSegmentProgress(episodeIndex, "failed", failure?.message || "项目保存失败");
          saveError = new Error(`第 ${episodeIndex} 段已生成，但项目保存失败：${failure?.message || "未返回保存结果"}`);
          writeBatchSegmentCache();
          publishBatchProgress("saving", `${saveError.message} 已缓存结果，可仅继续保存。`);
          return;
        }
        if (entry.status === "saved" || entry.status === "review_saved") {
          const operation = activeSaveOperations.get(episodeIndex);
          if (!isCurrentSaveOperation(operation)) return;
          dispatchSegmentStateEvent(episodeIndex, {
            type: "SAVE_SUCCEEDED",
            review: entry.status === "review_saved",
          });
          finishSaveOperation(operation);
          updateSegmentProgress(
            episodeIndex,
            entry.status,
            entry.status === "review_saved" ? "已保存，待检查" : "已保存",
          );
          const review = entry.status === "review_saved";
          saveError = null;
          segmentRepairReasons.delete(episodeIndex);
          queuedRepairIndexes.delete(episodeIndex);
          if (!review) markSegmentQualityStatus(episodeIndex, "saved");
          writeBatchSegmentCache();
          publishBatchProgress("saving", review
            ? `第 ${episodeIndex} 段已保存为待检查草稿。`
            : `已保存第 ${episodeIndex} / ${resolvedSegmentCount} 段。`);
        }
      },
    });

    async function drainBatchSaveController() {
      const nextSegmentToSave = batchSaveController
        .snapshot()
        .segments
        .find((entry) => entry.status !== "saved" && entry.status !== "review_saved")
        ?.segmentIndex;
      if (!nextSegmentToSave) return;
      const saveChain = batchSaveController.drain();
      await saveChain;
    }

    function queueReadySegmentSaves() {
      for (const rendered of renderedEpisodes) {
        if (!rendered) continue;
        const segmentState = segmentStateRecords.find((state) => state.index === rendered.episodeIndex);
        if (segmentState?.saveStatus === "saved" || segmentState?.saveStatus === "review_saved") continue;
        const snapshotEntry = batchSaveController.snapshot().segments[rendered.episodeIndex - 1];
        if (
          snapshotEntry?.status === "saving"
          || snapshotEntry?.status === "saved"
          || snapshotEntry?.status === "review_saved"
          || snapshotEntry?.status === "save_failed"
        ) continue;
        batchSaveController.cache(rendered.episodeIndex, rendered, {
          review: segmentState?.qualityStatus === "needs_review",
        });
      }
      void drainBatchSaveController();
    }

    async function restoreCachedRenderedSegments() {
      if (typeof window === "undefined") return 0;
      try {
        type CachedBatchDocument = {
          schemaVersion?: 1 | 2;
          revision?: number;
          durableBatchId?: string;
          projectId?: string | null;
          sourceHash?: string;
          contractHash?: string;
          resolvedSegmentCount?: number;
          qualityReports?: SegmentQualityReport[];
          needsReviewSegments?: Array<{
            episodeIndex?: number;
            reason?: string;
            result?: AnalysisResult;
          }>;
          repairAttempts?: Array<[string, number]>;
          invocationEvents?: BatchInvocationLedgerEvent[];
          renderOperations?: RenderOperationRefV2[];
          mode?: SegmentCountMode;
          requestedCount?: number | null;
          duration?: string;
          phase?: BatchGenerationPhase;
          segmentStates?: Array<SegmentStateRecord | { index?: number; status?: BatchSegmentStatus; message?: string }>;
          activeJobIds?: string[];
          segments?: Array<{
            episodeIndex?: number;
            title?: string;
            sourceText?: string;
            promptText?: string;
            result?: AnalysisResult;
            status?: SegmentQualityStatus | "review_saved" | "saved";
          }>;
        };
        let cache: CachedBatchDocument | null = null;
        try {
          const response = await fetch(`/api/segment-batch-cache/${encodeURIComponent(durableBatchId)}`, {
            method: "GET",
            cache: "no-store",
          });
          const data = await response.json().catch(() => null);
          if (response.ok && data?.ok && data.cache) cache = data.cache as CachedBatchDocument;
        } catch (serverCacheError) {
          console.warn("Failed to read durable batch cache", serverCacheError);
        }
        if (!cache) {
          const rawLegacyCache = window.localStorage.getItem(batchCacheKey);
          if (rawLegacyCache) {
            const legacyCache = JSON.parse(rawLegacyCache) as CachedBatchDocument;
            if (Array.isArray(legacyCache.segments)) cache = legacyCache;
          }
        }
        if (!cache) return 0;
        if (
          (batchProjectId !== null && cache.projectId !== batchProjectId)
          || cache.sourceHash !== batchSourceHash
          || cache.contractHash !== batchContractHash
          || cache.resolvedSegmentCount !== resolvedSegmentCount
          || !Array.isArray(cache.segments)
        ) {
          return 0;
        }

        if (cache.projectId) {
          activeProjectId = cache.projectId;
          batchProjectId = cache.projectId;
        }
        if (Array.isArray(cache.invocationEvents)) invocationLedger.restore(cache.invocationEvents);
        if (Array.isArray(cache.renderOperations)) {
          renderOperationRecords = retainBoundedRenderOperationAudits(cache.renderOperations);
        }

        let restoredCount = 0;
        const restoredJudgeItems: PendingCoverageJudgeSegment[] = [];
        if (Array.isArray(cache.segmentStates)) {
          if (cache.schemaVersion === 2) {
            const restoredStates = cache.segmentStates.filter((state): state is SegmentStateRecord => (
              Boolean(state)
              && "generationStatus" in state
              && "qualityStatus" in state
              && "saveStatus" in state
              && Number.isInteger(state.index)
            ));
            if (restoredStates.length === resolvedSegmentCount) {
              segmentStateRecords = restoredStates.map((state) => ({ ...state }));
              batchCacheRevision = Math.max(batchCacheRevision, Number(cache.revision) || 0);
              segmentProgressItems = segmentStateRecords.map((state) => {
                const episode = episodes.find((candidate) => candidate.episodeIndex === state.index);
                return {
                  index: state.index,
                  title: episode?.input.title,
                  status: progressStatusFromSegmentState(state),
                  message: state.message,
                };
              });
            }
          } else {
            for (const cachedState of cache.segmentStates) {
              if (!("status" in cachedState)) continue;
              const index = Number(cachedState.index);
              if (!Number.isInteger(index) || index < 1 || index > renderedEpisodes.length || !cachedState.status) continue;
              updateSegmentProgress(index, cachedState.status, cachedState.message);
            }
          }
        }
        if (Array.isArray(cache.qualityReports)) {
          for (const report of cache.qualityReports) {
            if (report && Number.isInteger(report.segmentIndex)) {
              qualityReports.set(report.segmentIndex, report);
            }
          }
        }
        if (Array.isArray(cache.repairAttempts)) {
          for (const attempt of cache.repairAttempts) {
            if (!Array.isArray(attempt) || typeof attempt[0] !== "string") continue;
            const count = Number(attempt[1]);
            if (Number.isInteger(count) && count > 0) repairAttemptCounts.set(attempt[0], count);
          }
        }
        if (Array.isArray(cache.needsReviewSegments)) {
          for (const cached of cache.needsReviewSegments) {
            const episodeIndex = Number(cached.episodeIndex);
            if (
              !Number.isInteger(episodeIndex)
              || episodeIndex < 1
              || episodeIndex > renderedEpisodes.length
              || !cached.result
            ) {
              continue;
            }
            const reason = String(cached.reason || "事件覆盖仍有歧义，保留首次结果等待检查。");
            needsReviewEpisodes.set(episodeIndex, { result: cached.result, reason });
            updateSegmentProgress(episodeIndex, "needs_review", reason);
          }
        }
        for (const cached of cache.segments) {
          const episodeIndex = Number(cached.episodeIndex);
          if (!Number.isInteger(episodeIndex) || episodeIndex < 1 || episodeIndex > renderedEpisodes.length) continue;
          if (renderedEpisodes[episodeIndex - 1]) continue;
          const episode = episodes.find((candidate) => candidate.episodeIndex === episodeIndex);
          const episodeInput = episode?.input;
          if (!episode || !episodeInput || !cached.result || !cached.promptText || !cached.sourceText) continue;
          const renderDuration = episodeInput.duration || selectedDurationValue();
          const normalizedCachedResult = normalizeBatchEpisodeResult(
            script,
            episodeIndex,
            resolvedSegmentCount || episodes.length,
            cached.result,
            renderDuration,
          );
          const restoredState = segmentStateRecords.find((state) => state.index === episodeIndex);
          if (restoredState?.generationStatus === "repair_detached" && restoredState.activeRepairJobId) {
            const restoredRendered: RenderedEpisode = {
              episodeIndex,
              episodeInput,
              result: normalizedCachedResult,
              promptText: buildVideoGenerationPromptText(normalizedCachedResult),
              sourceText: cached.sourceText,
            };
            renderedEpisodes[episodeIndex - 1] = restoredRendered;
            const review = restoredState.qualityStatus === "needs_review" || cached.status === "review_saved";
            batchSaveController.restore(episodeIndex, {
              payload: restoredRendered,
              review,
              status: cached.status === "review_saved" || cached.status === "saved" ? cached.status : "cached",
            });
            void watchDetachedRepair(episode, normalizedCachedResult, renderDuration, {
              jobId: restoredState.activeRepairJobId,
              contractHash: restoredState.contractHash || episodeInput.segmentContract?.contractHash || batchContractHash,
              resultHash: restoredState.resultHash || buildBatchSegmentResultHash(normalizedCachedResult),
            }, restoredState.updatedAt || Date.now());
            restoredCount += 1;
            continue;
          }
          const evaluated = normalizePatchAndEvaluateBatchSegment(
            script,
            episodeIndex,
            normalizedCachedResult,
            renderDuration,
            episodeInput.segmentContract,
            undefined,
            undefined,
            batchCoverageMode,
          );
          const outcome = routeBatchSegmentOutcome({
            gate: evaluated.gate,
            hasUsableResult: true,
            coverageStage: batchCoverageStage,
          });
          if (outcome.action === "enqueue_judge" || outcome.action === "enqueue_judge_shadow") {
            restoredJudgeItems.push({
              episode,
              result: evaluated.result,
              renderDuration,
              renderStartedAt: Date.now(),
              renderCompletedAt: Date.now(),
              packSize: 1,
              sidecar: null,
              localDecisions: evaluated.coverageDecisions,
            });
            updateSegmentProgress(episodeIndex, "adjudicating", "已恢复缓存，等待批量语义裁决");
            continue;
          }
          if (outcome.action === "needs_review") {
            markCoverageNeedsReview({
              episode,
              result: evaluated.result,
              renderDuration,
              renderStartedAt: Date.now(),
              renderCompletedAt: Date.now(),
              packSize: 1,
              sidecar: null,
              localDecisions: evaluated.coverageDecisions,
            }, buildTargetedRepairReason(evaluated.gate));
            continue;
          }
          if (outcome.action === "request_quality_patch" || outcome.action === "request_event_patch") {
            const routeError = qualityErrorForRoute(
              evaluated.gate,
              outcome,
              evaluated.result,
              evaluated.coverageDecisions,
            );
            queueSegmentRepair(episode, routeError.message, {
              result: evaluated.result,
              validationError: routeError,
              renderDuration,
              packSize: 1,
            });
            continue;
          }
          if (outcome.action !== "accept") continue;
          const validatedCachedResult = evaluated.result;
          legacyFatalCheck(episodeIndex, validatedCachedResult, evaluated.gate);
          const restoredRendered: RenderedEpisode = {
            episodeIndex,
            episodeInput,
            result: validatedCachedResult,
            promptText: buildVideoGenerationPromptText(validatedCachedResult),
            sourceText: cached.sourceText,
          };
          renderedEpisodes[episodeIndex - 1] = restoredRendered;
          const cachedStatus = cached.status || qualityReports.get(episodeIndex)?.status;
          if (cachedStatus === "saved" || cachedStatus === "review_saved") {
            batchSaveController.restore(episodeIndex, {
              payload: restoredRendered,
              review: cachedStatus === "review_saved",
              status: cachedStatus,
            });
            updateSegmentProgress(
              episodeIndex,
              cachedStatus === "review_saved" ? "review_saved" : "saved",
              cachedStatus === "review_saved" ? "已恢复已保存的待检查草稿" : "已从服务端缓存恢复已保存状态",
            );
            if (!completed.some((item) => item.segment.index === episodeIndex)) {
              completed.push({
                segment: { index: episodeIndex, text: cached.sourceText },
                result: validatedCachedResult,
                promptText: buildVideoGenerationPromptText(validatedCachedResult),
              });
            }
          } else {
            batchSaveController.restore(episodeIndex, {
              payload: restoredRendered,
              review: needsReviewEpisodes.has(episodeIndex),
              status: "cached",
            });
            updateSegmentProgress(episodeIndex, "cached", "已恢复缓存分段，继续按顺序保存");
          }
          segmentRepairReasons.delete(episodeIndex);
          queuedRepairIndexes.delete(episodeIndex);
          restoredCount += 1;
        }

        if (restoredJudgeItems.length) await runCoverageJudgeWave(restoredJudgeItems, 0);

        if (restoredCount > 0) {
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
          publishBatchProgress("saving", `已恢复缓存分段，继续按顺序保存：${restoredCount} 段`);
          queueReadySegmentSaves();
        }
        const restoredNeedsReviewCount = segmentStateRecords.filter((state) => (
          state.qualityStatus === "needs_review" || state.saveStatus === "review_saved"
        )).length;
        if (restoredNeedsReviewCount > 0) {
          publishBatchProgress(
            "needs_review",
            `已恢复 ${restoredNeedsReviewCount} 段待检查结果，不会重新生成。`,
          );
        }
        return restoredCount;
      } catch (cacheError) {
        console.warn("Failed to restore rendered batch segments from cache", cacheError);
        return 0;
      }
    }

    function storeRenderedEpisode(
      episode: SeasonPackEpisodeResult,
      episodeResult: AnalysisResult,
      reportMeta: {
        status?: SegmentQualityStatus;
        renderStartedAt?: number;
        renderCompletedAt?: number;
        durationMs?: number;
        packIndex?: number;
        packSize?: number;
        qualityGate?: ReturnType<typeof evaluateBatchSegmentQuality>;
        patchDiffs?: QualityPatchDiff[];
        codexRepairAttempted?: boolean;
        coverageDecisions?: CoverageDecision[];
        coverageReceiptCount?: number;
        coverageDurationMs?: number;
        judgeInvoked?: boolean;
        judgeWaveId?: string;
        judgeDecisionCount?: number;
        judgeDurationMs?: number;
        needsReviewReason?: string;
      } = {},
    ) {
      const episodeIndex = episode.episodeIndex;
      const episodeInput = episode.input;
      const fullVideoPrompt = buildVideoGenerationPromptText(episodeResult);
      const episodeScript = episodeSourceText(script, episodeIndex, resolvedSegmentCount || episodes.length, episodeInput, episodeResult);
      const repairReasons = segmentRepairReasons.get(episodeIndex) || [];
      const localPatchCount = (reportMeta.patchDiffs || []).filter((patch) => patch.patchSource === "local").length;
      if (localPatchCount > 0) {
        invocationLedger.record("localPatchOperations", { segmentIndex: episodeIndex, count: localPatchCount });
      }
      const stateBeforeStore = segmentStateRecords.find((state) => state.index === episodeIndex);
      const storedResultHash = buildBatchSegmentResultHash(episodeResult);
      if (
        stateBeforeStore?.generationStatus !== "repair_detached"
        && stateBeforeStore?.resultHash !== storedResultHash
      ) {
        if (stateBeforeStore?.generationStatus === "settled") {
          dispatchSegmentStateEvent(episodeIndex, { type: "RENDER_STARTED" });
        }
        dispatchSegmentStateEvent(episodeIndex, {
          type: "RENDER_SUCCEEDED",
          resultHash: storedResultHash,
          contractHash: episodeInput.segmentContract?.contractHash || batchContractHash,
        });
      }
      dispatchSegmentStateEvent(
        episodeIndex,
        reportMeta.status === "needs_review"
          ? { type: "QUALITY_NEEDS_REVIEW", message: reportMeta.needsReviewReason }
          : { type: "QUALITY_PASSED" },
      );
      qualityReports.set(
        episodeIndex,
        createSegmentQualityReport({
          batchId: seasonPackJob.id,
          projectId: activeProjectId || undefined,
          segmentIndex: episodeIndex,
          title: episodeResult.title || episodeInput.title,
          result: episodeResult,
          sourceText: episodeScript,
          status: reportMeta.status || (repairReasons.length ? "repaired" : "cached"),
          scheduleProfile: activeRenderScheduleProfile,
          packIndex: reportMeta.packIndex,
          packSize: reportMeta.packSize,
          repairCount: repairReasons.length,
          repairReasons,
          qualityGate: reportMeta.qualityGate,
          patchDiffs: reportMeta.patchDiffs,
          codexRepairAttempted: reportMeta.codexRepairAttempted,
          renderStartedAt: reportMeta.renderStartedAt,
          renderCompletedAt: reportMeta.renderCompletedAt,
          durationMs: reportMeta.durationMs,
          contractHash: episodeInput.segmentContract?.contractHash,
          coverageDecisions: reportMeta.coverageDecisions,
          coverageReceiptCount: reportMeta.coverageReceiptCount,
          coverageDurationMs: reportMeta.coverageDurationMs,
          judgeInvoked: reportMeta.judgeInvoked,
          judgeWaveId: reportMeta.judgeWaveId,
          judgeDecisionCount: reportMeta.judgeDecisionCount,
          judgeDurationMs: reportMeta.judgeDurationMs,
          needsReviewReason: reportMeta.needsReviewReason,
        }),
      );
      renderedEpisodes[episodeIndex - 1] = {
        episodeIndex,
        episodeInput,
        result: episodeResult,
        promptText: fullVideoPrompt,
        sourceText: episodeScript,
      };
      dispatchSegmentStateEvent(episodeIndex, { type: "CACHE_READY" });
      segmentRepairReasons.delete(episodeIndex);
      queuedRepairIndexes.delete(episodeIndex);
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
      const needsReview = reportMeta.status === "needs_review" || needsReviewEpisodes.has(episodeIndex);
      updateSegmentProgress(
        episodeIndex,
        needsReview ? "needs_review" : "cached",
        needsReview ? reportMeta.needsReviewReason || "已保留首次结果，等待检查并按序保存" : "已生成并缓存，等待前序保存",
      );
      publishBatchProgress(
        needsReview ? "needs_review" : "rendering",
        needsReview
          ? `第 ${episodeIndex} 段首次结果已保留，将保存为待检查草稿。`
          : `第 ${episodeIndex} / ${resolvedSegmentCount} 段已生成并缓存，继续处理剩余分段...`,
      );
      queueReadySegmentSaves();
    }

    async function renderSingleEpisodeWithQualityRepair(episode: SeasonPackEpisodeResult) {
      const episodeIndex = episode.episodeIndex;
      const episodeInput = episode.input;
      const renderScript = buildBatchEpisodeRenderScript(episodeInput, resolvedSegmentCount || episodes.length);
      const renderDuration = episodeInput.duration || selectedDurationValue();
      const renderOperation = beginRenderOperation(episodeIndex);

      updateSegmentProgress(episodeIndex, "repairing", "正在按单段质量生成修复");
      publishBatchProgress("repairing", `正在按单段质量生成第 ${episodeIndex} / ${resolvedSegmentCount} 段...`);
      const renderStartedAt = Date.now();
      try {
        const validatedEpisode = await renderBatchSegmentWithQualityRepair(
          renderScript,
          renderDuration,
          episodeIndex,
          resolvedSegmentCount || episodes.length,
          episodeInput.segmentContract,
          renderOperation,
        );
        if (validatedEpisode.detached) {
          markCoverageNeedsReview({
            episode,
            result: validatedEpisode.result,
            renderDuration,
            renderStartedAt,
            renderCompletedAt: Date.now(),
            packIndex: episodeIndex,
            packSize: 1,
            sidecar: null,
            localDecisions: validatedEpisode.coverageDecisions,
          }, "路径级修复仍在后台运行，首次结果已保留并将保存为待检查草稿。");
          return;
        }
        const repairState = segmentStateRecords.find((state) => state.index === episodeIndex);
        if (repairState?.generationStatus === "repair_pending") {
          const syntheticJobId = `single-regeneration:${episodeIndex}:${buildBatchSegmentResultHash(validatedEpisode.result).slice(0, 12)}`;
          dispatchSegmentStateEvent(episodeIndex, { type: "REPAIR_STARTED", jobId: syntheticJobId });
          dispatchSegmentStateEvent(episodeIndex, {
            type: "REPAIR_COMPLETED",
            jobId: syntheticJobId,
            resultHash: buildBatchSegmentResultHash(validatedEpisode.result),
          });
        }
        storeRenderedEpisode(episode, validatedEpisode.result, {
          status: "repaired",
          renderStartedAt,
          renderCompletedAt: Date.now(),
          packIndex: episodeIndex,
          packSize: 1,
          qualityGate: validatedEpisode.gate,
          patchDiffs: validatedEpisode.patchDiffs,
          codexRepairAttempted: validatedEpisode.codexRepairAttempted,
          coverageDecisions: validatedEpisode.coverageDecisions,
          coverageDurationMs: validatedEpisode.coverageDurationMs,
        });
      } catch (error) {
        if (error instanceof StaleSegmentOperationError) return;
        if (!(error instanceof BatchSegmentQualityValidationError) || !error.result) throw error;
        const repairState = segmentStateRecords.find((state) => state.index === episodeIndex);
        if (["repair_pending", "repair_running", "repair_detached"].includes(repairState?.generationStatus || "")) {
          dispatchSegmentStateEvent(episodeIndex, {
            type: "REPAIR_FAILED",
            jobId: repairState?.activeRepairJobId,
            errorCode: "REPAIR_VALIDATION_FAILED",
            message: "补生成结果未通过复检，已保留首次可用结果",
          });
        }
        const outcome = routeBatchSegmentOutcome({
          gate: error.gate,
          hasUsableResult: true,
          coverageStage: batchCoverageStage,
        });
        const judgeItem: PendingCoverageJudgeSegment = {
          episode,
          result: error.result,
          renderDuration,
          renderStartedAt,
          renderCompletedAt: Date.now(),
          packIndex: episodeIndex,
          packSize: 1,
          sidecar: null,
          localDecisions: error.coverageDecisions,
        };
        if (outcome.action === "enqueue_judge" || outcome.action === "enqueue_judge_shadow") {
          await runCoverageJudgeWave([judgeItem], episodeIndex);
          return;
        }
        markCoverageNeedsReview(judgeItem, buildTargetedRepairReason(error.gate));
      } finally {
        finishRenderOperation(renderOperation);
      }
    }

    function queueSegmentRepair(
      episode: SeasonPackEpisodeResult,
      reason: string,
      existing?: {
        result: AnalysisResult;
        validationError: unknown;
        renderDuration: string;
        renderStartedAt?: number;
        packIndex?: number;
        packSize?: number;
      },
    ) {
      const cachedRendered = renderedEpisodes[episode.episodeIndex - 1];
      if (cachedRendered) {
        try {
          const validatedCached = normalizePatchAndValidateBatchSegment(
            script,
            episode.episodeIndex,
            cachedRendered.result,
            cachedRendered.episodeInput.duration || selectedDurationValue(),
            cachedRendered.episodeInput.segmentContract,
            undefined,
            undefined,
            batchCoverageMode,
          );
          renderedEpisodes[episode.episodeIndex - 1] = {
            ...cachedRendered,
            result: validatedCached.result,
            promptText: buildVideoGenerationPromptText(validatedCached.result),
          };
        } catch {
          renderedEpisodes[episode.episodeIndex - 1] = undefined;
        }
      }
      if (renderedEpisodes[episode.episodeIndex - 1]) {
        segmentRepairReasons.delete(episode.episodeIndex);
        queuedRepairIndexes.delete(episode.episodeIndex);
        updateSegmentProgress(episode.episodeIndex, "cached", "已有合格缓存，继续按顺序保存");
        markSegmentQualityStatus(episode.episodeIndex, "cached", { repairReasons: [] });
        writeBatchSegmentCache();
        queueReadySegmentSaves();
        return;
      }
      if (queuedRepairIndexes.has(episode.episodeIndex)) return;
      const reasonType = classifyBatchRepairReason(reason);
      const repairFindings = existing?.validationError instanceof BatchSegmentQualityValidationError
        ? existing.validationError.findings
        : [];
      const safetyOnlyRepair = repairFindings.length > 0
        && repairFindings.every((finding) => finding.code === "sensitive_term");
      if (
        existing?.result
        && (!TASK_ONE_REPAIR_SCHEDULER_ENABLED || (!TASK_ONE_SAFETY_ENABLED && safetyOnlyRepair))
      ) {
        markCoverageNeedsReview({
          episode,
          result: existing.result,
          renderDuration: existing.renderDuration,
          renderStartedAt: existing.renderStartedAt || Date.now(),
          renderCompletedAt: Date.now(),
          packIndex: existing.packIndex,
          packSize: existing.packSize || 1,
          sidecar: null,
          localDecisions: existing.validationError instanceof BatchSegmentQualityValidationError
            ? existing.validationError.coverageDecisions
            : [],
        }, "任务一自动修复功能已关闭，首次结果已保留为待检查草稿。" );
        return;
      }
      registerSegmentRepairReason(episode.episodeIndex, reason);
      const attemptKey = buildBatchRepairAttemptKey(episode.episodeIndex, reasonType, repairFindings);
      const attemptCount = (repairAttemptCounts.get(attemptKey) || 0) + 1;
      repairAttemptCounts.set(attemptKey, attemptCount);
      if (attemptCount > MAX_BATCH_REPAIR_ATTEMPTS_PER_REASON) {
        updateSegmentProgress(episode.episodeIndex, "failed", `同类问题已自动修复 ${MAX_BATCH_REPAIR_ATTEMPTS_PER_REASON} 次，停止重复修复：${reason}`);
        markSegmentQualityStatus(episode.episodeIndex, "failed", { repairReasons: segmentRepairReasons.get(episode.episodeIndex) || [reason] });
        publishBatchProgress("failed", `第 ${episode.episodeIndex} 段同类问题重复出现，已停止自动重修。`);
        return;
      }
      queuedRepairIndexes.add(episode.episodeIndex);
      const repairLabel = batchRepairReasonLabel(reasonType);
      if (existing?.result) {
        const existingResultHash = buildBatchSegmentResultHash(existing.result);
        const existingState = segmentStateRecords.find((state) => state.index === episode.episodeIndex);
        if (existingState?.resultHash !== existingResultHash) {
          if (existingState?.generationStatus === "settled") {
            dispatchSegmentStateEvent(episode.episodeIndex, { type: "RENDER_STARTED" });
          }
          dispatchSegmentStateEvent(episode.episodeIndex, {
            type: "RENDER_SUCCEEDED",
            resultHash: existingResultHash,
            contractHash: episode.input.segmentContract?.contractHash || batchContractHash,
          });
        }
        dispatchSegmentStateEvent(episode.episodeIndex, { type: "QUALITY_BLOCKED", message: reason });
      }
      const item: RepairQueueItem = {
        episode,
        reason,
        reasonType,
        existingResult: existing?.result,
        validationError: existing?.validationError,
        renderDuration: existing?.renderDuration,
        renderStartedAt: existing?.renderStartedAt,
        packIndex: existing?.packIndex,
        packSize: existing?.packSize,
      };
      dispatchSegmentStateEvent(episode.episodeIndex, {
        type: "REPAIR_QUEUED",
        fingerprint: attemptKey,
        message: `${repairLabel}: ${existing ? "只补未通过字段" : reason}`,
      });
      const accepted = repairScheduler.enqueue({
        segmentIndex: episode.episodeIndex,
        fingerprint: attemptKey,
        payload: item,
      });
      if (!accepted) return;
      if (!repairFirstQueuedAtMs) repairFirstQueuedAtMs = Date.now();
      updateSegmentProgress(
        episode.episodeIndex,
        existing ? "patching" : "repairing",
        `${repairLabel}: ${existing ? "只补未通过字段" : reason}`,
      );
    }

    async function processSegmentRepairItem(item: RepairQueueItem) {
      if (batchQuotaPaused) return;
      const { episode, reasonType } = item;
      if (!item.existingResult) {
        invocationLedger.record("singleRegenerationCalls", { segmentIndex: episode.episodeIndex });
        updateSegmentProgress(episode.episodeIndex, "repairing", `${batchRepairReasonLabel(reasonType)}: Render Pack 无可用结果，正在补生成当前段`);
        await renderSingleEpisodeWithQualityRepair(episode);
        return;
      }
      updateSegmentProgress(episode.episodeIndex, "patching", `${batchRepairReasonLabel(reasonType)}: 正在只补授权叶子字段`);
      try {
        const renderDuration = item.renderDuration || episode.input.duration || selectedDurationValue();
        const repaired = await repairExistingBatchSegment(
          buildBatchEpisodeRenderScript(episode.input, resolvedSegmentCount || episodes.length),
          renderDuration,
          episode.episodeIndex,
          resolvedSegmentCount || episodes.length,
          item.existingResult,
          episode.input.segmentContract,
          item.validationError || new Error(item.reason),
        );
        if (repaired.detached) {
          markCoverageNeedsReview({
            episode,
            result: item.existingResult,
            renderDuration,
            renderStartedAt: item.renderStartedAt || Date.now(),
            renderCompletedAt: Date.now(),
            packIndex: item.packIndex,
            packSize: item.packSize || 1,
            sidecar: null,
            localDecisions: repaired.coverageDecisions,
          }, "路径级修复仍在后台运行，首次结果已保留并将保存为待检查草稿。");
          return;
        }
        storeRenderedEpisode(episode, repaired.result, {
          status: "repaired",
          renderStartedAt: item.renderStartedAt,
          renderCompletedAt: Date.now(),
          packIndex: item.packIndex,
          packSize: item.packSize || 1,
          qualityGate: repaired.gate,
          patchDiffs: repaired.patchDiffs,
          codexRepairAttempted: true,
          coverageDecisions: repaired.coverageDecisions,
          coverageDurationMs: repaired.coverageDurationMs,
        });
      } catch (repairError) {
        if (repairError instanceof StaleSegmentOperationError) return;
        const renderDuration = item.renderDuration || episode.input.duration || selectedDurationValue();
        const repairState = segmentStateRecords.find((state) => state.index === episode.episodeIndex);
        if (["repair_pending", "repair_running", "repair_detached"].includes(repairState?.generationStatus || "")) {
          dispatchSegmentStateEvent(episode.episodeIndex, {
            type: "REPAIR_FAILED",
            jobId: repairState?.activeRepairJobId,
            errorCode: "REPAIR_VALIDATION_FAILED",
            message: formatUserFacingError(repairError, "路径级 patch 未通过复检"),
          });
        }
        const validationRepairError = repairError instanceof BatchSegmentQualityValidationError ? repairError : null;
        const routedError = validationRepairError
          ? routeBatchSegmentOutcome({
              gate: validationRepairError.gate,
              hasUsableResult: Boolean(validationRepairError.result || item.existingResult),
              coverageStage: batchCoverageStage,
            })
          : null;
        const latestResult = validationRepairError?.result || item.existingResult;
        if (routedError && latestResult && (routedError.action === "enqueue_judge" || routedError.action === "enqueue_judge_shadow")) {
          queuedRepairIndexes.delete(episode.episodeIndex);
          await runCoverageJudgeWave([{
            episode,
            result: latestResult,
            renderDuration,
            renderStartedAt: item.renderStartedAt || Date.now(),
            renderCompletedAt: Date.now(),
            packIndex: item.packIndex,
            packSize: item.packSize || 1,
            sidecar: null,
            localDecisions: validationRepairError?.coverageDecisions.length
              ? validationRepairError.coverageDecisions
              : episode.input.segmentContract
                ? validateSegmentEventCoverage(latestResult, episode.input.segmentContract)
                : [],
          }], episode.episodeIndex);
          return;
        }
        if (routedError && latestResult && (routedError.action === "request_event_patch" || routedError.action === "request_quality_patch")) {
          queuedRepairIndexes.delete(episode.episodeIndex);
          const routeError = qualityErrorForRoute(
            validationRepairError!.gate,
            routedError,
            latestResult,
            validationRepairError!.coverageDecisions,
          );
          queueSegmentRepair(episode, routeError.message, {
            result: latestResult,
            validationError: routeError,
            renderDuration,
            renderStartedAt: item.renderStartedAt,
            packIndex: item.packIndex,
            packSize: item.packSize,
          });
          return;
        }
        markCoverageNeedsReview({
          episode,
          result: latestResult,
          renderDuration,
          renderStartedAt: item.renderStartedAt || Date.now(),
          renderCompletedAt: Date.now(),
          packIndex: item.packIndex,
          packSize: item.packSize || 1,
          sidecar: null,
          localDecisions: episode.input.segmentContract
            ? validateSegmentEventCoverage(latestResult, episode.input.segmentContract)
            : [],
        }, `${formatUserFacingError(repairError, "路径级 patch 未通过复检")}；首次结果已保留。`);
        if (CODEX_QUOTA_ERROR_PATTERN.test(String(repairError instanceof Error ? repairError.message : repairError))) {
          pauseBatchForCodexQuota([episode.episodeIndex], repairError);
        }
      }
    }

    repairScheduler = createBatchRepairScheduler<RepairQueueItem, void>({
      maxConcurrency: BATCH_SINGLE_RENDER_CONCURRENCY,
      execute: async (task) => processSegmentRepairItem(task.payload),
      onFailed: (task, error) => {
        queuedRepairIndexes.delete(task.segmentIndex);
        dispatchSegmentStateEvent(task.segmentIndex, {
          type: "REPAIR_FAILED",
          errorCode: "REPAIR_EXECUTION_FAILED",
          message: formatUserFacingError(error, "当前段修复任务失败，已保留可用结果"),
        });
        updateSegmentProgress(task.segmentIndex, "failed", formatUserFacingError(error, "当前段修复任务失败"));
      },
    });

    function signalRepairScheduler() {
      repairScheduler.signal();
    }

    async function runSegmentRepairPool() {
      await repairScheduler.waitForIdle();
    }

    function markCoverageNeedsReview(item: PendingCoverageJudgeSegment, reason: string) {
      needsReviewEpisodes.set(item.episode.episodeIndex, { result: item.result, reason });
      storeRenderedEpisode(item.episode, item.result, {
        status: "needs_review",
        packIndex: item.packIndex,
        packSize: item.packSize,
        renderStartedAt: item.renderStartedAt,
        renderCompletedAt: item.renderCompletedAt,
        coverageDecisions: item.localDecisions,
        needsReviewReason: reason,
      });
    }

    async function runCoverageJudgeWave(items: PendingCoverageJudgeSegment[], waveNumber: number) {
      if (!items.length) return;
      if (!batchEventFeatures.contractV2 || !coverageStageInvokesJudge(batchCoverageStage)) {
        for (const item of items) markCoverageNeedsReview(item, "事件覆盖存在歧义，Judge 未启用，保留首次结果等待检查。");
        return;
      }

      const cases = items.flatMap((item) => {
        const contract = item.episode.input.segmentContract;
        if (!contract) return [];
        return item.localDecisions.flatMap((decision) => {
          if (decision.status !== "ambiguous" || decision.importance !== "blocking") return [];
          const slot = contract.requiredEventSlots.find((candidate) => candidate.id === decision.slotId);
          if (!slot) return [];
          const inspectedFields = collectEventCoverageInspectedFields(item.result, slot);
          if (!inspectedFields.length) return [];
          return [{
            segmentIndex: item.episode.episodeIndex,
            slotId: slot.id,
            label: slot.label,
            importance: "blocking" as const,
            contractHash: contract.contractHash,
            resultHash: buildBatchSegmentResultHash(item.result),
            anchorGroups: slot.anchorGroups,
            conceptGroups: slot.conceptGroups,
            contradictionGroups: slot.contradictionGroups,
            sourceExcerpt: contract.sourceText,
            characterLocks: contract.characterLocks || [],
            forbiddenFutureEvents: contract.forbiddenFutureEvents || [],
            evidenceSelectors: slot.evidenceSelectors || [],
            inspectedFields,
          }];
        });
      });
      if (!cases.length) {
        for (const item of items) markCoverageNeedsReview(item, "事件覆盖缺少可裁决字段，保留首次结果等待检查。");
        return;
      }

      for (const item of items) updateSegmentProgress(item.episode.episodeIndex, "adjudicating", "正在批量判断事件语义覆盖");
      publishBatchProgress("adjudicating", `正在批量判断 ${cases.length} 个歧义事件，不改写首次提示词...`);
      let judgeJobs: EventCoverageCodexJob[] = [];
      let judgeWaveId = `wave-${waveNumber}-${buildBatchSegmentResultHash(cases)}`;
      const judgeStartedAt = Date.now();
      try {
        const caseChunks = Array.from(
          { length: Math.ceil(cases.length / 20) },
          (_, index) => cases.slice(index * 20, index * 20 + 20),
        );
        invocationLedger.record("judgeCalls", { count: caseChunks.length });
        const createdJobs = await Promise.all(caseChunks.map((caseChunk) => createEventCoverageCodexJob({
          batchId: seasonPackJob.id,
          renderRound: waveNumber,
          cases: caseChunk,
        })));
        judgeJobs = await Promise.all(createdJobs.map((created) => pollEventCoverageCodexJob(created.id)));
        judgeWaveId = judgeJobs.map((job) => job.waveId).join(",");
      } catch (error) {
        const reason = formatUserFacingError(error, "事件覆盖裁决失败");
        for (const item of items) markCoverageNeedsReview(item, `${reason}；首次结果已保留。`);
        if (CODEX_QUOTA_ERROR_PATTERN.test(String(error instanceof Error ? error.message : error))) {
          pauseBatchForCodexQuota(items.map((item) => item.episode.episodeIndex), error);
        }
        return;
      }

      const judgeDecisions = new Map<string, EventCoverageJudgeDecision>(
        judgeJobs.flatMap((job) => job.result?.decisions || []).map(
          (decision) => [`${decision.segmentIndex}:${decision.slotId}`, decision] as const,
        ),
      );
      const judgeDecisionCount = judgeJobs.reduce((count, job) => count + (job.result?.decisions.length || 0), 0);
      const submittedJudgeCases = new Map<string, (typeof cases)[number]>(
        cases.map((judgeCase) => [`${judgeCase.segmentIndex}:${judgeCase.slotId}`, judgeCase] as const),
      );
      const judgeDurationMs = Math.max(0, Date.now() - judgeStartedAt);
      for (const item of items) {
        const contract = item.episode.input.segmentContract;
        if (!contract) {
          markCoverageNeedsReview(item, "缺少本段生成契约，首次结果已保留。");
          continue;
        }
        const mergedDecisions = item.localDecisions.map((decision) => {
          if (decision.status !== "ambiguous" || decision.importance !== "blocking") return decision;
          const caseKey = `${item.episode.episodeIndex}:${decision.slotId}`;
          const judged = judgeDecisions.get(caseKey);
          const submittedCase = submittedJudgeCases.get(caseKey);
          const currentResultHash = buildBatchSegmentResultHash(item.result);
          const expectedPaths = submittedCase?.inspectedFields.map((field) => field.path).sort() || [];
          const inspectedPaths = judged?.inspectedPaths.slice().sort() || [];
          const trustedEvidence = Boolean(judged?.evidence.every((entry) => {
            const currentValue = String(getBatchSegmentRepairValueAtPath(item.result, entry.path) || "");
            const normalizedCurrent = currentValue.normalize("NFKC").replace(/\s+/g, "");
            const normalizedQuote = entry.quote.normalize("NFKC").replace(/\s+/g, "");
            return normalizedQuote.length > 0 && normalizedCurrent.includes(normalizedQuote);
          }));
          if (
            !judged
            || !submittedCase
            || submittedCase.contractHash !== contract.contractHash
            || submittedCase.resultHash !== currentResultHash
            || JSON.stringify(expectedPaths) !== JSON.stringify(inspectedPaths)
            || !trustedEvidence
            || judged.status === "uncertain"
          ) return decision;
          return {
            ...decision,
            status: judged.status === "covered"
              ? "covered" as const
              : judged.status === "missing"
                ? "definite_missing" as const
                : "contradiction" as const,
            evidencePaths: judged.evidence.map((entry) => entry.path),
            evidenceQuotes: judged.evidence.map((entry) => entry.quote),
            reasonCode: judged.status === "covered"
              ? "verified_receipt" as const
              : judged.status === "contradiction"
                ? "explicit_contradiction" as const
                : "required_field_empty" as const,
          };
        });

        if (batchCoverageStage === "judge-shadow") {
          const shadowEvaluation = normalizePatchAndEvaluateBatchSegment(
            script,
            item.episode.episodeIndex,
            item.result,
            item.renderDuration,
            contract,
            item.sidecar,
            undefined,
            "shadow",
          );
          const nonCoverageBlocking = shadowEvaluation.gate.blockingFindings.filter(
            (finding) => finding.code !== "ambiguous_required_event_slot",
          );
          if (nonCoverageBlocking.length) {
            const shadowRoute = routeBatchSegmentOutcome({
              gate: qualityGateWithBlockingFindings(shadowEvaluation.gate, nonCoverageBlocking),
              hasUsableResult: true,
              coverageStage: "shadow",
            });
            if (shadowRoute.action !== "accept") {
              markCoverageNeedsReview(item, "Judge shadow 仅记录结论；当前段仍有非语义质量阻断，首次结果已保留。");
              continue;
            }
          }
          legacyFatalCheck(item.episode.episodeIndex, shadowEvaluation.result, shadowEvaluation.gate);
          storeRenderedEpisode(item.episode, shadowEvaluation.result, {
            status: "cached",
            renderStartedAt: item.renderStartedAt,
            renderCompletedAt: item.renderCompletedAt,
            packIndex: item.packIndex,
            packSize: item.packSize,
            qualityGate: shadowEvaluation.gate,
            patchDiffs: shadowEvaluation.patchDiffs,
            coverageDecisions: item.localDecisions,
            coverageReceiptCount: item.sidecar?.receipts.length || 0,
            coverageDurationMs: shadowEvaluation.coverageDurationMs,
            judgeInvoked: true,
            judgeWaveId,
            judgeDecisionCount,
            judgeDurationMs,
          });
          continue;
        }

        if (mergedDecisions.some((decision) => decision.importance === "blocking" && decision.status === "ambiguous")) {
          markCoverageNeedsReview(item, "Judge 无法确定事件是否覆盖，首次结果已保留，未自动修改。");
          continue;
        }

        const evaluated = normalizePatchAndEvaluateBatchSegment(
          script,
          item.episode.episodeIndex,
          item.result,
          item.renderDuration,
          contract,
          item.sidecar,
          mergedDecisions,
          batchCoverageMode,
        );
        const outcome = routeBatchSegmentOutcome({
          gate: evaluated.gate,
          hasUsableResult: true,
          coverageStage: batchCoverageStage,
        });
        if (outcome.action === "accept") {
          legacyFatalCheck(item.episode.episodeIndex, evaluated.result, evaluated.gate);
          storeRenderedEpisode(item.episode, evaluated.result, {
            status: "cached",
            renderStartedAt: item.renderStartedAt,
            renderCompletedAt: item.renderCompletedAt,
            packIndex: item.packIndex,
            packSize: item.packSize,
            qualityGate: evaluated.gate,
            patchDiffs: evaluated.patchDiffs,
            coverageDecisions: mergedDecisions,
            coverageReceiptCount: item.sidecar?.receipts.length || 0,
            coverageDurationMs: evaluated.coverageDurationMs,
            judgeInvoked: true,
            judgeWaveId,
            judgeDecisionCount,
            judgeDurationMs,
          });
          continue;
        }

        if (outcome.action === "request_event_patch" || outcome.action === "request_quality_patch") {
          const routeError = qualityErrorForRoute(
            evaluated.gate,
            outcome,
            evaluated.result,
            evaluated.coverageDecisions,
          );
          updateSegmentProgress(item.episode.episodeIndex, "patching", "已确认真实缺失，只补授权叶子字段");
          queueSegmentRepair(item.episode, routeError.message, {
            result: evaluated.result,
            validationError: routeError,
            renderDuration: item.renderDuration,
            renderStartedAt: item.renderStartedAt,
            packIndex: item.packIndex,
            packSize: item.packSize,
          });
          continue;
        }

        markCoverageNeedsReview(item, buildTargetedRepairReason(evaluated.gate));
      }
    }

    async function reconcileAndRouteRenderPackResult(input: {
      operation: RenderOperationRefV2;
      job: VideoPromptPackCodexJob;
      packEpisodes: SeasonPackEpisodeResult[];
      packStartedAt: number;
      packIndex?: number;
      renderRound: number;
    }) {
      const { operation, job, packEpisodes, packStartedAt, packIndex, renderRound } = input;
      const currentSegments = Object.fromEntries(operation.segmentIndexes.map((episodeIndex) => {
        const state = segmentStateRecords.find((item) => item.index === episodeIndex);
        return [String(episodeIndex), {
          operationToken: state?.renderOperationToken,
          sourceHash: state?.expectedSourceHash,
          contractHash: state?.expectedContractHash || state?.contractHash,
          resultHash: state?.resultHash,
        }];
      }));
      const decision = reconcileDetachedRenderPack({
        operation,
        job,
        manifestValidated: job.protocolVersion === 2
          && job.status === "completed"
          && job.resultAvailable === true
          && Boolean(job.resultHash),
        currentSegments,
      });

      if (decision.status === "waiting") return decision;
      if (decision.status === "failed") {
        replaceRenderOperationRecord(terminateRenderOperation(operation, {
          state: "failed",
          errorCode: decision.errorCode,
        }));
        for (const episodeIndex of operation.segmentIndexes) {
          dispatchSegmentStateEvent(episodeIndex, {
            type: "RENDER_OPERATION_FAILED",
            operationToken: operation.operationToken,
            errorCode: decision.errorCode,
            message: "Render Pack 结果身份或最终清单无效，已停止自动处理。",
          });
        }
        await writeBatchSegmentCache();
        return decision;
      }
      if (decision.status === "ignored") {
        replaceRenderOperationRecord(terminateRenderOperation(operation, {
          state: "ignored",
          reasonCode: decision.reasonCode,
        }));
        for (const episodeIndex of decision.segmentIndexes) {
          dispatchSegmentStateEvent(episodeIndex, {
            type: "RENDER_OPERATION_IGNORED",
            operationToken: operation.operationToken,
            reasonCode: decision.reasonCode,
          });
        }
        await writeBatchSegmentCache();
        return decision;
      }
      if (decision.status === "replay") {
        if (operation.state !== "merged") {
          replaceRenderOperationRecord(terminateRenderOperation(operation, {
            state: "merged",
            finalManifestHash: String(job.resultHash),
            resultHashes: decision.resultHashes,
          }));
          await writeBatchSegmentCache();
        }
        return decision;
      }

      const pendingJudgeSegments: PendingCoverageJudgeSegment[] = [];
      const packDurationMs = renderPackDurationMs(job);
      const packCompletedAt = Date.now();
      try {
        const prepared = prepareRenderPackReconciliation({
          operation,
          eligibleSegmentIndexes: decision.segmentIndexes,
          contexts: packEpisodes.map((episode) => ({ episodeIndex: episode.episodeIndex, episode })),
          results: job.result?.segments || [],
          prepareSegment: ({ segmentIndex: episodeIndex, context, result: rawSegment }) => {
            const episode = context.episode;
            const renderDuration = episode.input.duration || selectedDurationValue();
            const episodeResult = normalizeBatchEpisodeResult(
              script,
              episodeIndex,
              resolvedSegmentCount || episodes.length,
              rawSegment.result,
              renderDuration,
            );
            const evaluated = normalizePatchAndEvaluateBatchSegment(
              script,
              episodeIndex,
              episodeResult,
              renderDuration,
              episode.input.segmentContract,
              rawSegment.coverageSidecar,
              undefined,
              batchCoverageMode,
            );
            const outcome = routeBatchSegmentOutcome({
              gate: evaluated.gate,
              hasUsableResult: true,
              coverageStage: batchCoverageStage,
            });
            if (outcome.action === "accept") {
              legacyFatalCheck(episodeIndex, evaluated.result, evaluated.gate);
            }
            const judgeItem: PendingCoverageJudgeSegment = {
              episode,
              result: evaluated.result,
              renderDuration,
              renderStartedAt: packStartedAt,
              renderCompletedAt: packCompletedAt,
              packIndex,
              packSize: packEpisodes.length,
              sidecar: rawSegment.coverageSidecar,
              localDecisions: evaluated.coverageDecisions,
            };
            return { episode, rawSegment, renderDuration, evaluated, outcome, judgeItem };
          },
        });

        await applyPreparedRenderPackReconciliation(prepared, {
          applySegment: ({ episode, rawSegment, renderDuration, evaluated, outcome, judgeItem }, episodeIndex) => {
            dispatchSegmentStateEvent(episodeIndex, {
              type: "RENDER_OPERATION_RECONCILED",
              operationToken: operation.operationToken,
              jobId: String(operation.jobId),
              resultHash: rawSegment.resultHash!,
              contractHash: episode.input.segmentContract?.contractHash,
            });
            if (outcome.action === "accept") {
              storeRenderedEpisode(episode, evaluated.result, {
                status: "cached",
                renderStartedAt: packStartedAt,
                renderCompletedAt: packCompletedAt,
                durationMs: packDurationMs || Math.max(0, packCompletedAt - packStartedAt),
                packIndex,
                packSize: packEpisodes.length,
                qualityGate: evaluated.gate,
                patchDiffs: evaluated.patchDiffs,
                coverageDecisions: evaluated.coverageDecisions,
                coverageReceiptCount: rawSegment.coverageSidecar?.receipts.length || 0,
                coverageDurationMs: evaluated.coverageDurationMs,
              });
              return;
            }
            if (outcome.action === "enqueue_judge" || outcome.action === "enqueue_judge_shadow") {
              pendingJudgeSegments.push(judgeItem);
              updateSegmentProgress(episodeIndex, "adjudicating", "本地无法确定事件覆盖，等待批量语义裁决");
              return;
            }
            if (outcome.action === "needs_review") {
              markCoverageNeedsReview(judgeItem, buildTargetedRepairReason(evaluated.gate));
              return;
            }
            if (outcome.action === "regenerate_segment") {
              const reason = summarizeQualityFindings(outcome.structuralFindings) || "结果结构不可用，需要补生成当前段";
              queueSegmentRepair(episode, reason);
              return;
            }
            const routeError = qualityErrorForRoute(
              evaluated.gate,
              outcome,
              evaluated.result,
              evaluated.coverageDecisions,
            );
            queueSegmentRepair(episode, routeError.message, {
              result: evaluated.result,
              validationError: routeError,
              renderDuration,
              renderStartedAt: packStartedAt,
              packIndex,
              packSize: packEpisodes.length,
            });
          },
          finalize: async () => {
            replaceRenderOperationRecord(terminateRenderOperation(operation, {
              state: "merged",
              finalManifestHash: String(job.resultHash),
              resultHashes: decision.resultHashes,
            }));
            await runCoverageJudgeWave(pendingJudgeSegments, renderRound);
            signalRepairScheduler();
            queueReadySegmentSaves();
            await writeBatchSegmentCache();
          },
        });
        return decision;
      } catch {
        const detached = detachRenderOperation(operation, {
          errorCode: "RENDER_RECONCILIATION_PREPARATION_FAILED",
        });
        replaceRenderOperationRecord(detached);
        for (const episodeIndex of operation.segmentIndexes) {
          dispatchSegmentStateEvent(episodeIndex, {
            type: "RENDER_OPERATION_DETACHED",
            operationToken: operation.operationToken,
            jobId: String(operation.jobId),
          });
        }
        await writeBatchSegmentCache();
        return {
          status: "failed" as const,
          errorCode: "RENDER_RECONCILIATION_PREPARATION_FAILED",
          retryable: true,
        };
      }
    }

    function observeDetachedRenderOperation(input: {
      operation: RenderOperationRefV2;
      packEpisodes: SeasonPackEpisodeResult[];
      packStartedAt: number;
      packIndex?: number;
      renderRound: number;
    }) {
      const jobId = input.operation.jobId;
      if (!jobId) return Promise.resolve();
      return renderPackObserverRegistryRef.current.observe(jobId, async (signal) => {
        const outcome = await observeRenderPackJob({
          jobId,
          mode: "background",
          signal,
          readJob: readVideoPromptPackCodexJob,
          sleep: waitForRenderObservation,
          isHidden: () => typeof document !== "undefined" && document.hidden,
        });
        if (outcome.status === "completed") {
          await reconcileAndRouteRenderPackResult({ ...input, job: outcome.job });
          return;
        }
        if (outcome.status === "terminal_failed") {
          if (outcome.job) {
            await reconcileAndRouteRenderPackResult({ ...input, job: outcome.job });
            return;
          }
          const failed = terminateRenderOperation(input.operation, {
            state: "failed",
            errorCode: outcome.reasonCode,
          });
          replaceRenderOperationRecord(failed);
          for (const episode of input.packEpisodes) {
            dispatchSegmentStateEvent(episode.episodeIndex, {
              type: "RENDER_OPERATION_FAILED",
              operationToken: input.operation.operationToken,
              errorCode: outcome.reasonCode,
              message: "原 Render Pack 已确认不可读取，不会触发逐段补生成。",
            });
          }
          await writeBatchSegmentCache();
        }
      });
    }

    async function renderPackedSegmentsWithQualityRepair(
      packEpisodes: SeasonPackEpisodeResult[],
      allowSplitFallback = true,
      packIndex?: number,
      renderRound = 1,
    ) {
      packEpisodes = packEpisodes.filter(
        (episode) => !renderedEpisodes[episode.episodeIndex - 1]
          && !needsReviewEpisodes.has(episode.episodeIndex)
          && !queuedRepairIndexes.has(episode.episodeIndex),
      );
      if (!packEpisodes.length) return;
      const renderOperations = new Map<number, RenderOperation>();
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
          segmentContract: episodeInput.segmentContract,
        };
      });

      let durableRenderOperation = createRenderOperationDraft({
        batchId: durableBatchId,
        segmentIndexes: packEpisodes.map((episode) => episode.episodeIndex),
        contractHashes: Object.fromEntries(packEpisodes.map((episode) => {
          const contractHash = episode.input.segmentContract?.contractHash;
          if (!contractHash) throw new Error(`Segment ${episode.episodeIndex} is missing its Render Contract hash`);
          return [String(episode.episodeIndex), contractHash];
        })),
        reconciliationContext: {
          sourceText: script,
          segments: packEpisodes.map((episode) => ({
            episodeIndex: episode.episodeIndex,
            title: episode.input.title,
            sourceText: episode.input.sourceText || script,
            duration: episode.input.duration || selectedDurationValue(),
            shotCount: episode.input.shotCount,
            segmentContract: episode.input.segmentContract,
          })),
        },
      });
      replaceRenderOperationRecord(durableRenderOperation);

      for (const episode of packEpisodes) {
        const state = segmentStateRecords.find((item) => item.index === episode.episodeIndex);
        if (state?.generationStatus !== "rendering" && state?.generationStatus !== "render_detached") {
          dispatchSegmentStateEvent(episode.episodeIndex, {
            type: "RENDER_OPERATION_CREATED",
            operationToken: durableRenderOperation.operationToken,
            expectedContractHash: episode.input.segmentContract?.contractHash,
          });
        }
        updateSegmentProgress(episode.episodeIndex, "running", `Render Pack 生成中：${packLabel}`);
        renderOperations.set(
          episode.episodeIndex,
          beginRenderOperation(episode.episodeIndex, durableRenderOperation.operationToken),
        );
      }
      await writeBatchSegmentCache();
      publishBatchProgress("rendering", `正在本地并发生成 Render Pack：第 ${packLabel} 段...`);
      const packStartedAt = Date.now();

      try {
        async function runRenderPack(mode: RenderPackCodexMode) {
          invocationLedger.record("renderPackCalls", { count: 1 });
          const packJob = await createVideoPromptPackCodexJob(
            packSegments,
            activeProjectId || undefined,
            mode,
            batchEventFeatures.contractV2 && batchEventFeatures.coverageSidecar,
            durableRenderOperation,
          );
          durableRenderOperation = attachRenderOperationJob(durableRenderOperation, {
            jobId: packJob.id,
            sourceHash: String(packJob.sourceHash || ""),
            aggregateContractHash: packJob.aggregateContractHash || null,
          });
          replaceRenderOperationRecord(durableRenderOperation);
          for (const episode of packEpisodes) {
            dispatchSegmentStateEvent(episode.episodeIndex, {
              type: "RENDER_OPERATION_OBSERVING",
              operationToken: durableRenderOperation.operationToken,
              jobId: packJob.id,
              expectedSourceHash: String(packJob.sourceHash || ""),
            });
          }
          await writeBatchSegmentCache();
          return pollVideoPromptPackCodexJob(packJob.id, packSegments.length);
        }

        let renderPackJob: VideoPromptPackCodexJob;
        try {
          renderPackJob = await runRenderPack(STRICT_UTF8_RENDER_PACK_MODE);
        } catch (strictError) {
          if (allowSplitFallback && packEpisodes.length > 1 && isRecoverableRenderPackError(strictError)) {
            const splitRenderPacks = buildRenderPacks(packEpisodes, { forceProfile: "SINGLE" }).packs;
            const reason = strictError instanceof Error ? strictError.message : "Render Pack strict UTF-8 generation failed";
            publishBatchProgress(
              "repairing",
              `Render Pack 第 ${packLabel} 段 strict UTF-8 失败，正在拆成 ${splitRenderPacks.length} 个单段包继续生成：${reason}`,
            );
            await Promise.all(splitRenderPacks.map((splitPack, splitIndex) => renderPackedSegmentsWithQualityRepair(splitPack, false, splitIndex + 1)));
            return;
          }
          throw strictError;
        }
        const packDurationMs = renderPackDurationMs(renderPackJob);
        const packCompletedAt = Date.now();
        if (packDurationMs >= SLOW_RENDER_PACK_WARNING_MS) {
          const minutes = Math.round(packDurationMs / 60_000);
          publishBatchProgress("rendering", `Render Pack ${packLabel} took ${minutes} minutes, marked as slow pack for diagnostics.`);
        }

        await reconcileAndRouteRenderPackResult({
          operation: durableRenderOperation,
          job: renderPackJob,
          packEpisodes,
          packStartedAt,
          packIndex,
          renderRound,
        });
        for (const renderOperation of renderOperations.values()) finishRenderOperation(renderOperation);
        return;

      } catch (error) {
        if (isRenderPackPollingInfrastructureError(error)) {
          durableRenderOperation = detachRenderOperation(durableRenderOperation, {
            errorCode: "RENDER_PACK_ATTENTION_TIMEOUT",
          });
          replaceRenderOperationRecord(durableRenderOperation);
          for (const episode of packEpisodes) {
            dispatchSegmentStateEvent(episode.episodeIndex, {
              type: "RENDER_OPERATION_DETACHED",
              operationToken: durableRenderOperation.operationToken,
              jobId: error.jobId,
            });
            finishRenderOperation(renderOperations.get(episode.episodeIndex));
          }
          await writeBatchSegmentCache();
          if (BATCH_RENDER_LATE_RECONCILIATION_ENABLED) {
            void observeDetachedRenderOperation({
              operation: durableRenderOperation,
              packEpisodes,
              packStartedAt,
              packIndex,
              renderRound,
            });
          }
          publishBatchProgress(
            "rendering",
            `Render Pack 第 ${packLabel} 段状态暂不可读，原任务 ${error.jobId} 已保留，不会创建逐段补生成任务。`,
          );
          return;
        }
        const reason = error instanceof Error ? error.message : "Render Pack 生成失败";
        if (CODEX_QUOTA_ERROR_PATTERN.test(String(reason))) {
          pauseBatchForCodexQuota(packEpisodes.map((episode) => episode.episodeIndex), error);
          return;
        }
        for (const episode of packEpisodes) {
          const renderOperation = renderOperations.get(episode.episodeIndex);
          if (!isCurrentRenderOperation(renderOperation)) continue;
          dispatchSegmentStateEvent(episode.episodeIndex, {
            type: "RENDER_OPERATION_FAILED",
            operationToken: durableRenderOperation.operationToken,
            errorCode: "RENDER_PACK_FAILED",
            message: reason,
          });
          finishRenderOperation(renderOperation);
        }
        throw error;
      }
    }

    await restoreCachedRenderedSegments();

    const renderSchedule = buildRenderPacks(episodes);
    renderPhaseStartedAtMs = Date.now();
    activeRenderScheduleProfile = renderSchedule.profile;
    const renderPacks = renderSchedule.packs;
    let nextPackToRender = 0;
    const renderPackConcurrency = Math.min(renderSchedule.concurrency, renderPacks.length);
    const renderPackShape = renderPacks.map((pack) => pack.length).join("/");
    publishBatchProgress(
      "rendering",
      `调度策略：${renderSchedule.profile}，${renderPackConcurrency} 包并发，分包 ${renderPackShape}。`,
    );

    async function renderNextPack() {
      while (!batchQuotaPaused && nextPackToRender < renderPacks.length) {
        const packIndex = nextPackToRender;
        nextPackToRender += 1;
        const renderRound = Math.floor(packIndex / Math.max(1, renderPackConcurrency)) + 1;
        await renderPackedSegmentsWithQualityRepair(renderPacks[packIndex], true, packIndex + 1, renderRound);
      }
    }

    await Promise.allSettled(Array.from({ length: renderPackConcurrency }, () => renderNextPack()));
    renderPhaseFinishedAtMs = Date.now();
    await runSegmentRepairPool();
    if (repairFirstQueuedAtMs) repairFinishedAtMs = Date.now();

    if (batchQuotaPaused) {
      writeBatchSegmentCache();
      await batchCachePersistChain;
      publishBatchProgress(
        "quota_paused",
        `${batchQuotaPauseMessage || CODEX_QUOTA_EXHAUSTED_DISPLAY_MESSAGE} 已生成结果和缓存均已保留。`,
      );
      setBatchGenerating(false);
      return;
    }

    const finalNeedsReviewCount = segmentStateRecords.filter((state) => (
      state.qualityStatus === "needs_review" || state.saveStatus === "review_saved"
    )).length;
    if (finalNeedsReviewCount) {
      queueReadySegmentSaves();
      await drainBatchSaveController();
      await batchCachePersistChain;
      const reviewSaveError = saveError as Error | null;
      if (reviewSaveError) {
        publishBatchProgress("saving", `${reviewSaveError.message} 已保留全部缓存；下次恢复只会继续保存。`);
        setBatchGenerating(false);
        return;
      }
      const unsavedReviewSegmentStates = segmentStateRecords.filter((state) => (
        state.saveStatus !== "saved" && state.saveStatus !== "review_saved"
      ));
      if (unsavedReviewSegmentStates.length > 0) {
        writeBatchSegmentCache();
        await batchCachePersistChain;
        publishBatchProgress(
          "saving",
          `仍有 ${unsavedReviewSegmentStates.length} 段待检查结果尚未落库，已保留缓存；不会重新生成。`,
        );
        setBatchGenerating(false);
        return;
      }
      publishBatchProgress(
        "needs_review",
        `${finalNeedsReviewCount} 段事件证据仍不确定，首次结果已按原样保存为待检查草稿；其余合格段已保存。`,
      );
      clearBatchRecoveryState();
      setBatchGenerating(false);
      return;
    }

    for (const rendered of renderedEpisodes) {
      if (!rendered) {
        throw new Error("有分段未完成单段质量生成，请重新生成。");
      }
    }
    queueReadySegmentSaves();
    await drainBatchSaveController();
    await batchCachePersistChain;
    const finalSaveError = saveError as Error | null;
    if (finalSaveError) {
      publishBatchProgress("saving", `${finalSaveError.message} 已保留全部缓存；下次恢复只会继续保存。`);
      setBatchGenerating(false);
      return;
    }

    const finalBatchCacheWriteError = batchCacheWriteError as Error | null;
    if (finalBatchCacheWriteError) {
      setGenerationProgress(`分段已保存，但服务端恢复缓存写入失败：${finalBatchCacheWriteError.message}`);
    }

    if (latestSaveRef.current?.versionId) {
      setResumeVersionId(latestSaveRef.current.versionId);
      creatingNewEpisodeRef.current = false;
      setCreatingNewEpisode(false);
    }
    publishBatchProgress("completed", `已生成 ${completed.length} 段，并按顺序保存到同一个项目。`);
    clearBatchRecoveryState();
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
      setBatchProgress((current) => {
        if (!current || current.phase === "completed" || current.phase === "failed") return current;
        const failedAtMs = Date.now();
        return {
          ...current,
          phase: "failed",
          currentMessage: message,
          updatedAtMs: failedAtMs,
          finishedAtMs: failedAtMs,
          elapsedMs: Math.max(0, failedAtMs - current.startedAtMs),
        };
      });
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
  const visibleBatchElapsedMs = batchProgress
    ? Math.max(
        0,
        (batchProgress.finishedAtMs || batchProgressTick || batchProgress.updatedAtMs) - batchProgress.startedAtMs,
      )
    : 0;
  const batchElapsedLabel = batchProgress
    ? batchProgress.phase === "completed" || batchProgress.phase === "failed"
      ? `总耗时 ${formatBatchElapsedMs(batchProgress.elapsedMs || visibleBatchElapsedMs)}`
      : `已用时 ${formatBatchElapsedMs(visibleBatchElapsedMs)}`
    : "";

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
                disabled={loading || uploadingText || batchGenerating || batchRecoveryChecking}
                className="prompt-send-button"
                aria-label={batchRecoveryChecking ? "正在检查待保存结果" : loading ? "正在生成" : "生成视频提示词"}
                title={batchRecoveryChecking ? "正在检查待保存结果" : loading ? "正在生成" : "生成视频提示词"}
              >
                {loading || batchGenerating || batchRecoveryChecking ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
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
        {batchSaveRecovery && !batchGenerating && (
          <div className="mt-4 flex w-full max-w-5xl items-center justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/8 px-4 py-3 text-sm text-amber-50">
            <span>检测到已生成但尚未全部保存的分段结果。</span>
            <button
              type="button"
              onClick={() => void resumeCachedBatchSavesOnly(batchSaveRecovery)}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-200/25 bg-amber-200/12 px-3 py-2 text-xs font-semibold transition hover:bg-amber-200/20"
            >
              <FileText className="h-4 w-4" />
              继续保存已缓存段
            </button>
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
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300 md:grid-cols-8">
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">已保存 {batchProgress.savedCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">已缓存 {batchProgress.cachedCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">生成中 {batchProgress.runningCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">修复 {batchProgress.repairingCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">裁决 {batchProgress.adjudicatingCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">待检查 {batchProgress.needsReviewCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">保存 {batchProgress.savingCount}</span>
              <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">等待 {batchProgress.pendingCount}</span>
            </div>
            {batchElapsedLabel && (
              <div className="mt-2 inline-flex rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1 text-xs font-semibold text-cyan-50">
                {batchElapsedLabel}
              </div>
            )}
            {batchProgress.qualityReportSummary && batchProgress.qualityReportSummary.totalReports > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300 md:grid-cols-4 xl:grid-cols-8">
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  质量均分 {batchProgress.qualityReportSummary.averageQualityScore}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  建议检查 {batchProgress.qualityReportSummary.suggestedReviewCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  阻断 {batchProgress.qualityReportSummary.blockingCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  可本地修 {batchProgress.qualityReportSummary.patchableCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  提醒 {batchProgress.qualityReportSummary.warningCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  风险 {batchProgress.qualityReportSummary.riskCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  本地 patch {batchProgress.qualityReportSummary.localPatchCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  Codex 修复 {batchProgress.qualityReportSummary.codexRepairCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  语义裁决 {batchProgress.qualityReportSummary.judgeInvocationCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  事件 patch {batchProgress.qualityReportSummary.eventPatchCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  待人工检查 {batchProgress.qualityReportSummary.needsReviewCount}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  最高风险 {formatBatchSafetyRisk(batchProgress.qualityReportSummary.highestSafetyRisk)}
                </span>
                <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1">
                  最慢段 {batchProgress.qualityReportSummary.slowestSegmentIndex ? `第 ${batchProgress.qualityReportSummary.slowestSegmentIndex} 段 ${formatBatchDurationMs(batchProgress.qualityReportSummary.slowestDurationMs)}` : "暂无"}
                </span>
              </div>
            )}
            {batchProgress.invocationMetrics && (
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300 md:grid-cols-3 xl:grid-cols-6">
                <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">Render 调用 {batchProgress.invocationMetrics.renderPackCalls}</span>
                <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">单段补生成 {batchProgress.invocationMetrics.singleRegenerationCalls}</span>
                <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">路径任务 {batchProgress.invocationMetrics.pathPatchJobCreated}</span>
                <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">路径完成 {batchProgress.invocationMetrics.pathPatchCompleted}</span>
                <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">Judge 调用 {batchProgress.invocationMetrics.judgeCalls}</span>
                <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">本地操作 {batchProgress.invocationMetrics.localPatchOperations}</span>
              </div>
            )}
            {batchProgress.timingMetrics && (
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
                <span>渲染墙钟 {formatBatchDurationMs(batchProgress.timingMetrics.renderWallMs)}</span>
                <span>修复等待 {formatBatchDurationMs(batchProgress.timingMetrics.repairWaitMs)}</span>
                <span>保存耗时 {formatBatchDurationMs(batchProgress.timingMetrics.saveMs)}</span>
                <span>关键路径 {formatBatchDurationMs(batchProgress.timingMetrics.criticalPathMs)}</span>
              </div>
            )}
            {batchProgress.segments.length > 0 && (
              <div className="mt-3 flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
                {batchProgress.segments.map((segment) => (
                  <span
                    key={segment.index}
                    title={segment.message || segment.title || ""}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${
                      segment.status === "saved" || segment.status === "completed"
                        ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-50"
                        : segment.status === "running" || segment.status === "saving" || segment.status === "validating" || segment.status === "adjudicating"
                          ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-50"
                          : segment.status === "repairing" || segment.status === "patching"
                            ? "border-amber-300/20 bg-amber-300/10 text-amber-50"
                            : segment.status === "failed" || segment.status === "needs_review" || segment.status === "review_saved" || segment.status === "quota_paused"
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
