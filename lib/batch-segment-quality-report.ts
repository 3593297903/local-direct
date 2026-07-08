export type SegmentQualityStatus = "rendered" | "repaired" | "cached" | "saved" | "failed";

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
  qualityFindings: string[];
  safetyRisk: SegmentSafetyRisk;
  safetyFindings: string[];
  contractHash?: string;
  renderHash: string;
  sourceHash: string;
};

export type BatchQualityReportSummary = {
  totalReports: number;
  averageQualityScore: number;
  suggestedReviewCount: number;
  highestSafetyRisk: SegmentSafetyRisk;
  slowestSegmentIndex?: number;
  slowestDurationMs: number;
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
  renderStartedAt?: number;
  renderCompletedAt?: number;
  durationMs?: number;
  contractHash?: string;
};

const HIGH_RISK_PATTERNS = [
  "自杀",
  "割腕",
  "上吊",
  "性侵",
  "强奸",
  "真实公众人物",
  "国徽",
  "警徽",
  "血泊",
  "尸体",
];

const MEDIUM_RISK_PATTERNS = [
  "公安",
  "警察",
  "警方",
  "政府",
  "政治",
  "未成年",
  "伤口",
  "血迹",
  "血腥",
  "凶手",
  "杀",
  "犯罪",
  "暴力",
];

const LOW_RISK_PATTERNS = [
  "冲突",
  "惊悚",
  "恐惧",
  "威胁",
  "紧张",
  "悬疑",
];

const RISK_RANK: Record<SegmentSafetyRisk, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export function createSegmentQualityReport(input: CreateSegmentQualityReportInput): SegmentQualityReport {
  const promptText = collectPromptText(input.result);
  const quality = computeSegmentQualityScore(input.result, {
    repairCount: input.repairCount || 0,
    repairReasons: input.repairReasons || [],
  });
  const safety = detectSegmentSafetyRisk([collectSafetyText(input.result), input.sourceText].join("\n"));
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
    qualityFindings: quality.findings,
    safetyRisk: safety.risk,
    safetyFindings: safety.findings,
    contractHash: input.contractHash,
    renderHash: stableReportHash(promptText),
    sourceHash: stableReportHash(input.sourceText),
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
  const high = collectRiskMatches(text, HIGH_RISK_PATTERNS);
  if (high.length) {
    return { risk: "high", findings: high };
  }

  const medium = collectRiskMatches(text, MEDIUM_RISK_PATTERNS);
  if (medium.length) {
    return { risk: "medium", findings: medium };
  }

  const low = collectRiskMatches(text, LOW_RISK_PATTERNS);
  if (low.length) {
    return { risk: "low", findings: low };
  }

  return { risk: "none", findings: [] };
}

export function summarizeSegmentQualityReports(reports: SegmentQualityReport[]): BatchQualityReportSummary {
  if (!reports.length) {
    return {
      totalReports: 0,
      averageQualityScore: 0,
      suggestedReviewCount: 0,
      highestSafetyRisk: "none",
      slowestDurationMs: 0,
    };
  }

  const totalScore = reports.reduce((sum, report) => sum + report.qualityScore, 0);
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
    highestSafetyRisk,
    slowestSegmentIndex: slowest?.segmentIndex,
    slowestDurationMs: slowest?.durationMs || 0,
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
