import type { BatchSegmentQualityGate, QualityPatchDiff } from "./batch-segment-quality-gate";
import type { CoverageDecision } from "./batch-event-coverage";
import { detectPromptSafetyRisk } from "./prompt-safety-policy";

export type SegmentQualityStatus = "rendered" | "repaired" | "cached" | "saved" | "needs_review" | "failed";

export type SegmentSafetyRisk = "none" | "low" | "medium" | "high";

export type SegmentQualityReport = {
  batchId: string;
  projectId?: string;
  segmentIndex: number;
  title: string;
  status: SegmentQualityStatus;
  scheduleProfile: string;
  packIndex?: number;
  packSize?: number;
  durationMs: number;
  renderStartedAt?: number;
  renderCompletedAt?: number;
  repairCount: number;
  repairReasons: string[];
  qualityScore: number;
  promptQualityScore: number;
  qualityFindings: string[];
  blockingCount: number;
  patchableCount: number;
  warningCount: number;
  riskCount: number;
  localPatchCount: number;
  codexPatchCount: number;
  patchDiffs: QualityPatchDiff[];
  codexRepairAttempted: boolean;
  codexRepairSegmentCount: number;
  safetyRisk: SegmentSafetyRisk;
  complianceRisk: SegmentSafetyRisk;
  safetyFindings: string[];
  contractHash?: string;
  renderHash: string;
  sourceHash: string;
  coverageReceiptCount: number;
  verifiedCoverageCount: number;
  localCoveredSlotCount: number;
  ambiguousSlotCount: number;
  definiteMissingSlotCount: number;
  contradictionSlotCount: number;
  judgeInvoked: boolean;
  judgeWaveId?: string;
  judgeDecisionCount: number;
  judgeDurationMs: number;
  coverageDurationMs: number;
  eventPatchCount: number;
  eventPatchPaths: string[];
  needsReviewReason?: string;
};

export type BatchQualityReportSummary = {
  totalReports: number;
  averageQualityScore: number;
  suggestedReviewCount: number;
  blockingCount: number;
  patchableCount: number;
  warningCount: number;
  riskCount: number;
  localPatchCount: number;
  codexPatchCount: number;
  codexRepairCount: number;
  codexRepairSegmentCount: number;
  highestSafetyRisk: SegmentSafetyRisk;
  slowestSegmentIndex?: number;
  slowestDurationMs: number;
  judgeInvocationCount: number;
  eventPatchCount: number;
  needsReviewCount: number;
};

type ReportAnalysisResult = {
  title?: unknown;
  duration?: unknown;
  style?: unknown;
  contentType?: unknown;
  optimizedScript?: unknown;
  workflow?: {
    fullVideoPrompt?: unknown;
    fullNegativePrompt?: unknown;
  };
  storyboard?: unknown;
};

type CreateSegmentQualityReportInput = {
  batchId: string;
  projectId?: string;
  segmentIndex: number;
  title: string;
  result: ReportAnalysisResult;
  sourceText: string;
  status: SegmentQualityStatus;
  scheduleProfile: string;
  packIndex?: number;
  packSize?: number;
  repairCount?: number;
  repairReasons?: string[];
  qualityGate?: BatchSegmentQualityGate;
  patchDiffs?: QualityPatchDiff[];
  codexRepairAttempted?: boolean;
  renderStartedAt?: number;
  renderCompletedAt?: number;
  durationMs?: number;
  contractHash?: string;
  coverageDecisions?: CoverageDecision[];
  coverageReceiptCount?: number;
  judgeInvoked?: boolean;
  judgeWaveId?: string;
  judgeDecisionCount?: number;
  judgeDurationMs?: number;
  coverageDurationMs?: number;
  needsReviewReason?: string;
};

const RISK_RANK: Record<SegmentSafetyRisk, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export function createSegmentQualityReport(input: CreateSegmentQualityReportInput): SegmentQualityReport {
  const promptText = collectPromptText(input.result);
  const quality = input.qualityGate
    ? {
        score: input.qualityGate.score,
        findings: input.qualityGate.findings.map(formatGateFindingForReport),
        blockingCount: input.qualityGate.blockingFindings.length,
        patchableCount: input.qualityGate.patchableFindings.length,
        warningCount: input.qualityGate.warningFindings.length,
        riskCount: input.qualityGate.riskFindings.length,
      }
    : {
        ...computeSegmentQualityScore(input.result, {
          repairCount: input.repairCount || 0,
          repairReasons: input.repairReasons || [],
        }),
        blockingCount: 0,
        patchableCount: 0,
        warningCount: 0,
        riskCount: 0,
      };
  const safety = detectSegmentSafetyRisk([collectSafetyText(input.result), input.sourceText].join("\n"));
  const gateSafety = input.qualityGate
    ? {
        risk: input.qualityGate.complianceRisk,
        findings: input.qualityGate.findings
          .filter((finding) => finding.code === "sensitive_term")
          .map((finding) => `${finding.ruleId || "safety"}: ${finding.message} (${finding.affectedPathCount || 1} 路径)`),
      }
    : safety;
  const patchDiffs = input.patchDiffs || [];
  const localPatchCount = patchDiffs.filter((patch) => patch.patchSource === "local").length;
  const codexPatchCount = patchDiffs.filter((patch) => patch.patchSource === "codex").length;
  const codexRepairSegmentCount = input.codexRepairAttempted ? 1 : 0;
  const coverageDecisions = input.coverageDecisions || [];
  const eventPatchPaths = patchDiffs
    .filter((patch) => ["missing_required_event_slot", "continuity_contradiction", "ambiguous_required_event_slot"].includes(patch.code))
    .map((patch) => patch.path);
  const durationMs = input.durationMs
    ?? (
      typeof input.renderStartedAt === "number" && typeof input.renderCompletedAt === "number"
        ? Math.max(0, input.renderCompletedAt - input.renderStartedAt)
        : 0
    );

  return {
    batchId: input.batchId,
    projectId: input.projectId,
    segmentIndex: input.segmentIndex,
    title: input.title,
    status: input.status,
    scheduleProfile: input.scheduleProfile,
    packIndex: input.packIndex,
    packSize: input.packSize,
    durationMs,
    renderStartedAt: input.renderStartedAt,
    renderCompletedAt: input.renderCompletedAt,
    repairCount: input.repairCount || 0,
    repairReasons: input.repairReasons || [],
    qualityScore: quality.score,
    promptQualityScore: quality.score,
    qualityFindings: quality.findings,
    blockingCount: quality.blockingCount,
    patchableCount: quality.patchableCount,
    warningCount: quality.warningCount,
    riskCount: quality.riskCount,
    localPatchCount,
    codexPatchCount,
    patchDiffs,
    codexRepairAttempted: Boolean(input.codexRepairAttempted),
    codexRepairSegmentCount,
    safetyRisk: gateSafety.risk,
    complianceRisk: gateSafety.risk,
    safetyFindings: Array.from(new Set(gateSafety.findings)),
    contractHash: input.contractHash,
    renderHash: stableReportHash(promptText),
    sourceHash: stableReportHash(input.sourceText),
    coverageReceiptCount: input.coverageReceiptCount || 0,
    verifiedCoverageCount: coverageDecisions.filter((decision) => decision.status === "covered").length,
    localCoveredSlotCount: coverageDecisions.filter((decision) => decision.status === "covered" && decision.reasonCode === "verified_local_bundle").length,
    ambiguousSlotCount: coverageDecisions.filter((decision) => decision.status === "ambiguous").length,
    definiteMissingSlotCount: coverageDecisions.filter((decision) => decision.status === "definite_missing").length,
    contradictionSlotCount: coverageDecisions.filter((decision) => decision.status === "contradiction").length,
    judgeInvoked: Boolean(input.judgeInvoked),
    judgeWaveId: input.judgeWaveId,
    judgeDecisionCount: input.judgeDecisionCount || 0,
    judgeDurationMs: input.judgeDurationMs || 0,
    coverageDurationMs: input.coverageDurationMs || 0,
    eventPatchCount: eventPatchPaths.length,
    eventPatchPaths,
    needsReviewReason: input.needsReviewReason,
  };
}

export function updateSegmentQualityReportStatus(
  report: SegmentQualityReport,
  status: SegmentQualityStatus,
  patch: Partial<Pick<SegmentQualityReport, "durationMs" | "repairCount" | "repairReasons" | "qualityScore" | "qualityFindings" | "safetyRisk" | "safetyFindings">> = {},
): SegmentQualityReport {
  return {
    ...report,
    status,
    ...patch,
  };
}

function formatGateFindingForReport(finding: BatchSegmentQualityGate["findings"][number]) {
  const location = finding.path ? `${finding.path}: ` : "";
  const length = finding.currentLength !== undefined && finding.minimumLength !== undefined
    ? ` (${finding.currentLength}/${finding.minimumLength})`
    : "";
  return `${finding.severity}:${finding.code}: ${location}${finding.message}${length}`;
}

export function computeSegmentQualityScore(
  result: ReportAnalysisResult,
  options: { repairCount?: number; repairReasons?: string[] } = {},
) {
  let score = 100;
  const findings: string[] = [];
  const promptText = collectPromptText(result);
  const compactPrompt = promptText.replace(/\s+/g, "");
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  const minimumPromptLength = storyboard.length >= 4 ? 900 : 650;

  if (compactPrompt.length < minimumPromptLength) {
    score -= 25;
    findings.push(`提示词过短：${compactPrompt.length}/${minimumPromptLength}`);
  }

  if (/(?:undefined|null)/i.test(promptText)) {
    score -= 35;
    findings.push("包含 undefined/null 占位文本");
  }

  if (/(?:第\s*[0-9一二三四五六七八九十百]+\s*集|本集|单集|剧集)/.test(promptText)) {
    score -= 18;
    findings.push("仍包含剧集术语");
  }

  if (/如上|同上|见上文|^\s*略\s*$/m.test(promptText)) {
    score -= 18;
    findings.push("包含不可执行占位描述");
  }

  if (/16\s*:\s*9\s*竖屏|竖屏\s*16\s*:\s*9|横屏\s*竖屏/.test(promptText)) {
    score -= 20;
    findings.push("包含画幅方向冲突");
  }

  const shortShotFields = countShortShotFields(storyboard);
  if (shortShotFields > 0) {
    score -= Math.min(20, shortShotFields * 4);
    findings.push(`有 ${shortShotFields} 个镜头字段偏短`);
  }

  const repairCount = options.repairCount || 0;
  if (repairCount > 0) {
    score -= Math.min(20, repairCount * 8);
    findings.push(`修复 ${repairCount} 次`);
  }

  for (const reason of options.repairReasons || []) {
    if (reason.trim()) findings.push(reason.trim());
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    findings: Array.from(new Set(findings)),
  };
}

export function detectSegmentSafetyRisk(text: string): { risk: SegmentSafetyRisk; findings: string[] } {
  const policyRisk = detectPromptSafetyRisk(text);
  return {
    risk: policyRisk.risk,
    findings: policyRisk.findings.map((finding) => (
      `${finding.match}: ${finding.reason}`
    )),
  };
}

export function summarizeSegmentQualityReports(reports: SegmentQualityReport[]): BatchQualityReportSummary {
  if (!reports.length) {
    return {
      totalReports: 0,
      averageQualityScore: 0,
      suggestedReviewCount: 0,
      blockingCount: 0,
      patchableCount: 0,
      warningCount: 0,
      riskCount: 0,
      localPatchCount: 0,
      codexPatchCount: 0,
      codexRepairCount: 0,
      codexRepairSegmentCount: 0,
      highestSafetyRisk: "none",
      slowestDurationMs: 0,
      judgeInvocationCount: 0,
      eventPatchCount: 0,
      needsReviewCount: 0,
    };
  }

  const totalScore = reports.reduce((sum, report) => sum + report.qualityScore, 0);
  const blockingCount = reports.reduce((sum, report) => sum + report.blockingCount, 0);
  const patchableCount = reports.reduce((sum, report) => sum + report.patchableCount, 0);
  const warningCount = reports.reduce((sum, report) => sum + report.warningCount, 0);
  const riskCount = reports.reduce((sum, report) => sum + report.riskCount, 0);
  const localPatchCount = reports.reduce((sum, report) => sum + report.localPatchCount, 0);
  const codexPatchCount = reports.reduce((sum, report) => sum + report.codexPatchCount, 0);
  const codexRepairCount = reports.filter((report) => report.codexRepairAttempted).length;
  const codexRepairSegmentCount = reports.reduce((sum, report) => sum + report.codexRepairSegmentCount, 0);
  const judgeInvocationCount = reports.filter((report) => report.judgeInvoked).length;
  const eventPatchCount = reports.reduce((sum, report) => sum + report.eventPatchCount, 0);
  const needsReviewCount = reports.filter((report) => report.status === "needs_review").length;
  const highestSafetyRisk = reports.reduce<SegmentSafetyRisk>(
    (highest, report) => RISK_RANK[report.safetyRisk] > RISK_RANK[highest] ? report.safetyRisk : highest,
    "none",
  );
  const slowest = reports.reduce<SegmentQualityReport | undefined>(
    (current, report) => !current || report.durationMs > current.durationMs ? report : current,
    undefined,
  );

  return {
    totalReports: reports.length,
    averageQualityScore: Math.round(totalScore / reports.length),
    suggestedReviewCount: reports.filter((report) =>
      report.status === "failed"
      || report.qualityScore < 85
      || report.repairCount > 0
      || RISK_RANK[report.safetyRisk] >= RISK_RANK.medium
    ).length,
    blockingCount,
    patchableCount,
    warningCount,
    riskCount,
    localPatchCount,
    codexPatchCount,
    codexRepairCount,
    codexRepairSegmentCount,
    highestSafetyRisk,
    slowestSegmentIndex: slowest?.segmentIndex,
    slowestDurationMs: slowest?.durationMs || 0,
    judgeInvocationCount,
    eventPatchCount,
    needsReviewCount,
  };
}

function collectPromptText(result: ReportAnalysisResult) {
  const workflow = result.workflow || {};
  return [
    cleanText(result.title),
    cleanText(result.duration),
    cleanText(result.style),
    cleanText(result.contentType),
    cleanText(result.optimizedScript),
    cleanText(workflow.fullVideoPrompt),
    cleanText(workflow.fullNegativePrompt),
    Array.isArray(result.storyboard) ? JSON.stringify(result.storyboard.map(stripNegativePromptFields)) : "",
  ].filter(Boolean).join("\n");
}

function stripNegativePromptFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNegativePromptFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/negative/i.test(key))
        .map(([key, item]) => [key, stripNegativePromptFields(item)]),
    );
  }
  return value;
}

function collectSafetyText(result: ReportAnalysisResult) {
  const workflow = result.workflow || {};
  return [
    cleanText(result.title),
    cleanText(result.duration),
    cleanText(result.style),
    cleanText(result.contentType),
    cleanText(result.optimizedScript),
    cleanText(workflow.fullVideoPrompt),
    Array.isArray(result.storyboard) ? JSON.stringify(result.storyboard.map(stripNegativePromptFields)) : "",
  ].filter(Boolean).join("\n");
}

function countShortShotFields(storyboard: unknown[]) {
  let count = 0;
  for (const shot of storyboard) {
    if (!shot || typeof shot !== "object") continue;
    const record = shot as Record<string, unknown>;
    for (const field of ["visual", "composition", "lighting", "sound", "shotPurpose", "videoPrompt"]) {
      const value = cleanText(record[field]).replace(/\s+/g, "");
      if (value && value.length < 6) count += 1;
    }
  }
  return count;
}

function collectRiskMatches(text: string, patterns: string[]) {
  return patterns
    .filter((pattern) => text.includes(pattern))
    .map((pattern) => `包含「${pattern}」`);
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stableReportHash(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return `qr_${(hash >>> 0).toString(36)}`;
}
