"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnalysisResult } from "@/types";
import {
  analyzeSegmentPromptQuality,
  summarizeSegmentPromptQuality,
  type SegmentPromptQualityIssue,
} from "@/lib/segment-prompt-quality";
import {
  BookOpen,
  Boxes,
  Building2,
  CalendarClock,
  Check,
  Clapperboard,
  Copy,
  Download,
  Edit3,
  FileText,
  Image as ImageIcon,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";

const SHOW_DIRECTOR_MEMORY = false;
const STORYBOARD_FAILED_GRACE_POLLS = 5;
const CODEX_QUOTA_EXHAUSTED_CODE = "CODEX_QUOTA_EXHAUSTED";
const CODEX_QUOTA_EXHAUSTED_DISPLAY_MESSAGE = "Codex 额度已用完或暂时受限，请恢复额度后再继续生成。";
const CODEX_QUOTA_ERROR_PATTERN =
  /CODEX_QUOTA_EXHAUSTED|Codex 额度已用完|insufficient[_\s-]?quota|usage limit|rate\s*limit|limit reached|billing|credits?|RESOURCE_EXHAUSTED|429/i;

type ProjectSummary = {
  id: string;
  title: string;
  content_type?: string | null;
  style?: string | null;
  duration?: string | null;
  status: string;
  created_at: string;
};

type ProjectShot = {
  id: string;
  shotNumber: number;
  timeRange?: string | null;
  scene?: string | null;
  visual?: string | null;
  shotType?: string | null;
  composition?: string | null;
  cameraMovement?: string | null;
  lighting?: string | null;
  sound?: string | null;
  dialogue?: string | null;
  emotion?: string | null;
  transition?: string | null;
  shotPurpose?: string | null;
  firstFramePrompt?: string | null;
  videoPrompt?: string | null;
  lastFramePrompt?: string | null;
  negativePrompt?: string | null;
};

type VisualAsset = {
  id: string;
  projectId?: string | null;
  versionId?: string | null;
  shotId?: string | null;
  shotNumber?: number | null;
  entityId?: string | null;
  type: "SHOT_STORYBOARD" | "CHARACTER_TURNAROUND" | "SCENE_KEYART" | "PROP_SHEET" | string;
  name: string;
  variantKey?: string | null;
  prompt?: string | null;
  imageUrl?: string | null;
  status?: string | null;
  error?: string | null;
  isPrimary?: boolean;
  locked?: boolean;
  referenceWeight?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectVisualEntity = {
  id: string;
  projectId?: string | null;
  type: "CHARACTER" | "SCENE" | "PROP" | "STYLE" | string;
  key: string;
  name: string;
  aliases?: string[];
  canonicalPrompt?: string | null;
  visualLock?: string | null;
  negativeLock?: string | null;
  status?: "CANDIDATE" | "APPROVED" | "LOCKED" | "ARCHIVED" | string;
  primaryAssetId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectDetailView = "episodes" | "assets";
type AssetLibraryType = "CHARACTER" | "SCENE" | "PROP" | "STYLE";

type ShotVisualReference = {
  id: string;
  projectId?: string | null;
  versionId?: string | null;
  shotId: string;
  entityId: string;
  role?: "SUBJECT" | "BACKGROUND" | "PROP" | "STYLE" | string;
  order?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectVersion = {
  id: string;
  versionNumber: number;
  title: string;
  originalScript: string;
  optimizedScript?: string | null;
  contentType?: string | null;
  style?: string | null;
  duration?: string | null;
  status: string;
  storyboardImageUrl?: string | null;
  storyboardImagePrompt?: string | null;
  fullVideoPrompt?: string | null;
  qualityCheck?: Record<string, unknown> | null;
  createdAt: string;
  shots: ProjectShot[];
  visualAssets?: VisualAsset[];
  shotVisualReferences?: ShotVisualReference[];
};

type CharacterProfile = {
  id: string;
  name: string;
  role?: string | null;
  appearance?: string | null;
  personality?: string | null;
  relationshipState?: string | null;
  visualLock?: string | null;
  importance: number;
  locked: boolean;
};

type StoryLoop = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  importance: number;
};

type MemoryItem = {
  id: string;
  type: string;
  title?: string | null;
  content: string;
  keywords?: unknown[] | null;
  importance: number;
  recency: number;
  isEnabled?: boolean;
  source?: string | null;
  createdAt?: string;
};

type ProjectDetail = {
  id: string;
  title: string;
  originalScript: string;
  optimizedScript?: string | null;
  contentType?: string | null;
  style?: string | null;
  duration?: string | null;
  status: string;
  storyBible?: Record<string, unknown> | null;
  contextSummary?: string | null;
  stateVector?: Record<string, unknown> | null;
  openLoops?: unknown[] | null;
  characterProfiles?: CharacterProfile[];
  storyLoops?: StoryLoop[];
  memoryItems?: MemoryItem[];
  visualEntities?: ProjectVisualEntity[];
  createdAt: string;
  updatedAt: string;
  versions: ProjectVersion[];
};

type StoryboardCodexPanelTask = {
  id: string;
  jobId: string;
  shotNumber: number;
  batchIndex: number;
  batchTotal: number;
  prompt: string;
  size: string;
  quality: string;
  status: "pending" | "running" | "completed" | "failed";
  imageUrl: string | null;
  error: string | null;
  attempts?: number;
  sourceImagePath?: string | null;
  outputHash?: string | null;
  imageFingerprint?: string | null;
  codexLogPath?: string | null;
  duplicateOfPanelId?: string | null;
};

type StoryboardCodexJob = {
  id: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  panels: StoryboardCodexPanelTask[];
  error: string | null;
};

type VisualAssetCodexTask = {
  id: string;
  jobId: string;
  entityId: string;
  entityType: "CHARACTER" | "SCENE" | "PROP" | "STYLE" | string;
  entityName: string;
  entityKey: string;
  assetType: "CHARACTER_TURNAROUND" | "SCENE_KEYART" | "PROP_SHEET" | string;
  mode: "initial" | "regenerate" | "edit_text" | "edit_image" | string;
  prompt: string;
  size: string;
  quality: string;
  status: "pending" | "running" | "completed" | "failed";
  imageUrl: string | null;
  error: string | null;
  attempts?: number;
  sourceImagePath?: string | null;
  codexLogPath?: string | null;
};

type VisualAssetCodexJob = {
  id: string;
  projectId: string;
  versionId: string;
  entityId: string;
  entityType: "CHARACTER" | "SCENE" | "PROP" | "STYLE" | string;
  entityName: string;
  entityKey: string;
  assetType: "CHARACTER_TURNAROUND" | "SCENE_KEYART" | "PROP_SHEET" | string;
  mode: "initial" | "regenerate" | "edit_text" | "edit_image" | string;
  status: "pending" | "running" | "completed" | "failed";
  task: VisualAssetCodexTask;
  error: string | null;
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

type VideoPromptCodexJob = {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: Record<string, unknown> | null;
  error?: string | null;
};

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function getFriendlyProjectError(message: string) {
  if (message.includes(CODEX_QUOTA_EXHAUSTED_CODE) || CODEX_QUOTA_ERROR_PATTERN.test(message)) {
    return CODEX_QUOTA_EXHAUSTED_DISPLAY_MESSAGE;
  }
  if (/endpoint is unavailable|Cannot GET|Not Found/i.test(message)) {
    return "项目详情接口暂时不可用。请重启 Nest API 后刷新页面。";
  }
  if (/Unauthorized/i.test(message)) return "请先登录后查看项目。";
  return message || "项目详情加载失败，请稍后再试。";
}

function formatJson(value: unknown) {
  if (!value || typeof value !== "object") return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function parseJsonOrThrow(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("JSON 格式不正确");
  }
}

function buildPromptText(version: ProjectVersion) {
  if (version.fullVideoPrompt) return version.fullVideoPrompt;

  const shots = version.shots
    .map((shot) =>
      [
        `${shot.shotNumber}. ${shot.scene || "镜头"}`,
        `画面：${shot.visual || "-"}`,
        `景别：${shot.shotType || "-"}`,
        `运镜：${shot.cameraMovement || "-"}`,
        `情绪：${shot.emotion || "-"}`,
        `转场：${shot.transition || "-"}`,
        `视频提示词：${shot.videoPrompt || "-"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `标题：${version.title}`,
    `时长：${version.duration || "-"}`,
    `风格：${version.style || "-"}`,
    `原始文案：\n${version.originalScript}`,
    version.optimizedScript ? `生成文案：\n${version.optimizedScript}` : "",
    `镜头表：\n${shots}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAnalysisResultPromptText(result: AnalysisResult) {
  const workflow = result.workflow;
  const shotLines = result.storyboard
    .map((shot) =>
      [
        `${shot.shotNumber}. ${shot.scene || "镜头"} ${shot.timeRange || ""}`.trim(),
        `画面：${shot.visual || "-"}`,
        `景别：${shot.shotType || "-"}`,
        `机位/构图：${shot.composition || "-"}`,
        `运镜：${shot.cameraMovement || "-"}`,
        `光影：${shot.lighting || "-"}`,
        `声音：${shot.sound || "-"}`,
        `台词：${shot.dialogue || "-"}`,
        `镜头目的：${shot.shotPurpose || "-"}`,
        `视频提示词：${shot.videoPrompt || "-"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `核心主题\n\n${workflow?.coreTheme || result.title}`,
    `完整视频提示词\n\n${workflow?.fullVideoPrompt || result.optimizedScript}`,
    workflow?.fullNegativePrompt ? `完整负向提示词\n\n${workflow.fullNegativePrompt}` : "",
    `镜头表\n\n${shotLines}`,
  ].filter(Boolean).join("\n\n");
}

function parseDurationSeconds(value?: string | null) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  const seconds = match ? Number.parseFloat(match[1]) : 15;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 15;
}

function formatShotSecond(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function buildShotTimeRange(index: number, totalShots: number, duration?: string | null) {
  const safeTotal = Math.max(1, totalShots);
  const totalSeconds = parseDurationSeconds(duration);
  const start = (totalSeconds * index) / safeTotal;
  const end = (totalSeconds * (index + 1)) / safeTotal;
  return `${formatShotSecond(start)}-${formatShotSecond(end)}秒`;
}

function buildAnalysisResultFromProjectVersion(project: ProjectDetail, version: ProjectVersion): AnalysisResult {
  const duration = version.duration || project.duration || "15秒";
  const storyboard = version.shots.map((shot, index) => ({
    shotNumber: shot.shotNumber,
    timeRange: shot.timeRange || buildShotTimeRange(index, version.shots.length, duration),
    scene: shot.scene || "镜头",
    visual: shot.visual || shot.videoPrompt || "画面按本段剧情推进。",
    shotType: shot.shotType || "中景",
    composition: shot.composition || "保持电影级构图，主体清晰，空间关系明确。",
    cameraMovement: shot.cameraMovement || "稳定轻微推进",
    lighting: shot.lighting || "自然电影光影，色调与本段风格一致。",
    sound: shot.sound || "真实环境声",
    dialogue: shot.dialogue || "无台词",
    emotion: shot.emotion || "克制",
    transition: shot.transition || "自然切换",
    shotPurpose: shot.shotPurpose || "推动本段剧情信息。",
    firstFramePrompt: shot.firstFramePrompt || shot.visual || shot.videoPrompt || "镜头起始画面。",
    videoPrompt: shot.videoPrompt || shot.visual || "本镜头视频提示词。",
    lastFramePrompt: shot.lastFramePrompt || shot.visual || shot.videoPrompt || "镜头结束画面。",
    negativePrompt: shot.negativePrompt || "no gore, no explicit injury detail, no unreadable text",
  }));
  const fullVideoPrompt = version.fullVideoPrompt || buildPromptText(version);

  return {
    title: version.title || project.title,
    contentType: version.contentType || project.contentType || "短剧 / 通用",
    duration,
    style: version.style || project.style || "电影级写实",
    diagnosis: [],
    optimizedScript: version.optimizedScript || version.originalScript,
    workflow: {
      sourceAnalysis: version.originalScript,
      coreTheme: version.optimizedScript || version.originalScript,
      videoParameterLock: `总时长：${version.duration || project.duration || "15秒"}\n画幅：16:9\n风格：${version.style || project.style || "电影级写实"}`,
      screenplay: version.optimizedScript || version.originalScript,
      filmScript: fullVideoPrompt,
      fullVideoPrompt,
      fullNegativePrompt: storyboard.map((shot) => shot.negativePrompt).filter(Boolean).join("\n"),
      concisePrompt: version.optimizedScript || version.originalScript,
    },
    storyboard,
    recommendedItems: [],
    editingNotes: [],
    qualityCheck: version.qualityCheck || {},
  };
}

function getShotAssets(version: ProjectVersion, shot: ProjectShot, type?: VisualAsset["type"]) {
  return (version.visualAssets || []).filter((asset) => {
    const sameShot = asset.shotId ? asset.shotId === shot.id : asset.shotNumber === shot.shotNumber;
    return sameShot && (!type || asset.type === type);
  });
}

function getStoryboardAssetShotNumbers(version: ProjectVersion) {
  return new Set(
    (version.visualAssets || [])
      .filter((asset) => asset.type === "SHOT_STORYBOARD" && asset.imageUrl && typeof asset.shotNumber === "number")
      .map((asset) => Number(asset.shotNumber)),
  );
}

function getEpisodeStoryboardActionLabel(version: ProjectVersion) {
  const generatedCount = getStoryboardAssetShotNumbers(version).size;
  if (generatedCount <= 0) return "生成本段镜头分镜图";
  if (generatedCount < version.shots.length) return "补齐本段镜头分镜图";
  return "重新生成本段分镜图";
}

function getEpisodeStoryboardTargetShots(version: ProjectVersion) {
  const generatedShotNumbers = getStoryboardAssetShotNumbers(version);
  if (generatedShotNumbers.size > 0 && generatedShotNumbers.size < version.shots.length) {
    return version.shots.filter((shot) => !generatedShotNumbers.has(shot.shotNumber));
  }
  return version.shots;
}

function mapProjectShotToStoryboardJobShot(shot: ProjectShot) {
  return {
    shotNumber: shot.shotNumber,
    scene: shot.scene || undefined,
    visual: shot.visual || undefined,
    shotType: shot.shotType || undefined,
    composition: shot.composition || undefined,
    cameraMovement: shot.cameraMovement || undefined,
    lighting: shot.lighting || undefined,
    sound: shot.sound || undefined,
    dialogue: shot.dialogue || undefined,
    emotion: shot.emotion || undefined,
    transition: shot.transition || undefined,
    shotPurpose: shot.shotPurpose || undefined,
    videoPrompt: shot.videoPrompt || undefined,
    negativePrompt: shot.negativePrompt || undefined,
  };
}

function getProjectVisualAssets(project: ProjectDetail | null) {
  return (project?.versions || []).flatMap((version) => version.visualAssets || []);
}

function getEntityVisualAssets(project: ProjectDetail | null, entity: ProjectVisualEntity) {
  return getProjectVisualAssets(project).filter((asset) => asset.entityId === entity.id);
}

function getPrimaryEntityAsset(project: ProjectDetail | null, entity: ProjectVisualEntity) {
  const assets = getEntityVisualAssets(project, entity);
  return assets.find((asset) => asset.id === entity.primaryAssetId) || assets.find((asset) => asset.isPrimary) || assets[0] || null;
}

function getProjectVisualEntities(project: ProjectDetail | null, type?: ProjectVisualEntity["type"]) {
  return (project?.visualEntities || []).filter((entity) => !type || entity.type === type);
}

function getVisualEntityStatusLabel(status?: string | null) {
  if (status === "LOCKED") return "已锁定";
  if (status === "APPROVED") return "已批准";
  if (status === "ARCHIVED") return "已归档";
  return "候选";
}

function getVisualAssetTypeForEntity(entityType?: string | null): "CHARACTER_TURNAROUND" | "SCENE_KEYART" | "PROP_SHEET" {
  if (entityType === "CHARACTER") return "CHARACTER_TURNAROUND";
  if (entityType === "PROP") return "PROP_SHEET";
  return "SCENE_KEYART";
}

function getRetryingStoryboardPanelCount(job: StoryboardCodexJob) {
  return job.panels.filter((panel) => panel.status === "pending" && Boolean(panel.error)).length;
}

function getFailedStoryboardPanelMessage(job: StoryboardCodexJob) {
  const failedPanels = job.panels.filter((panel) => panel.status === "failed");
  if (!failedPanels.length) return job.error || "Codex 分镜图任务失败";

  return failedPanels
    .map((panel) => `镜头 ${panel.shotNumber} 生成失败：${panel.error || job.error || "未知错误"}`)
    .join("；");
}

export function ProjectsClient() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [listError, setListError] = useState("");
  const [projectDetailError, setProjectDetailError] = useState("");
  const [deleteMode, setDeleteMode] = useState(false);
  const [checkedProjectIds, setCheckedProjectIds] = useState<string[]>([]);
  const [deletingProjects, setDeletingProjects] = useState(false);
  const [deletingEpisode, setDeletingEpisode] = useState(false);
  const [projectDetailView, setProjectDetailView] = useState<ProjectDetailView>("episodes");
  const [activeAssetType, setActiveAssetType] = useState<AssetLibraryType>("CHARACTER");
  const [storyboardGeneratingShotNumbers, setStoryboardGeneratingShotNumbers] = useState<number[]>([]);
  const [storyboardGenerationMessage, setStoryboardGenerationMessage] = useState("");
  const [storyboardGenerationError, setStoryboardGenerationError] = useState("");
  const [promptSafetyLoading, setPromptSafetyLoading] = useState(false);
  const [promptSafetyMessage, setPromptSafetyMessage] = useState("");
  const [promptSafetyError, setPromptSafetyError] = useState("");
  const [promptRepairInstruction, setPromptRepairInstruction] = useState("");
  const [promptRepairLoading, setPromptRepairLoading] = useState(false);
  const [promptRepairMessage, setPromptRepairMessage] = useState("");
  const [promptRepairError, setPromptRepairError] = useState("");
  const [visualAssetGeneratingEntityId, setVisualAssetGeneratingEntityId] = useState("");
  const [visualAssetGenerationMessage, setVisualAssetGenerationMessage] = useState("");
  const [visualAssetGenerationError, setVisualAssetGenerationError] = useState("");
  const [promptDownloadPanelOpen, setPromptDownloadPanelOpen] = useState(false);
  const [promptDownloadRangeStart, setPromptDownloadRangeStart] = useState(1);
  const [promptDownloadRangeEnd, setPromptDownloadRangeEnd] = useState(1);

  const selectedVersion = useMemo(() => {
    if (!project) return null;
    return project.versions.find((version) => version.id === selectedVersionId) || project.versions[0] || null;
  }, [project, selectedVersionId]);

  const sortedProjectVersions = useMemo(
    () => [...(project?.versions || [])].sort((a, b) => a.versionNumber - b.versionNumber),
    [project],
  );
  const minPromptDownloadVersion = sortedProjectVersions[0]?.versionNumber || 1;
  const maxPromptDownloadVersion = sortedProjectVersions[sortedProjectVersions.length - 1]?.versionNumber || 1;
  const projectPromptQualityItems = useMemo(
    () =>
      sortedProjectVersions.map((version) => {
        const qualityIssues = analyzeSegmentPromptQuality({
          segmentNumber: version.versionNumber,
          title: version.title,
          duration: version.duration,
          fullVideoPrompt: buildPromptText(version),
          optimizedScript: version.optimizedScript || version.originalScript,
          shots: version.shots as unknown as Array<Record<string, unknown>>,
        });
        return {
          version,
          qualityIssues,
          summary: summarizeSegmentPromptQuality(qualityIssues),
        };
      }),
    [sortedProjectVersions],
  );
  const selectedVersionQualityIssues = useMemo(
    () => projectPromptQualityItems.find((item) => item.version.id === selectedVersion?.id)?.qualityIssues || [],
    [projectPromptQualityItems, selectedVersion?.id],
  );
  const projectPromptQualityIssueCount = projectPromptQualityItems.reduce(
    (count, item) => count + item.summary.totalCount,
    0,
  );

  useEffect(() => {
    if (!selectedVersion) return;
    setPromptDownloadRangeStart(selectedVersion.versionNumber || 1);
    setPromptDownloadRangeEnd(selectedVersion.versionNumber || 1);
    setPromptRepairInstruction("");
    setPromptRepairMessage("");
    setPromptRepairError("");
  }, [selectedVersion?.id]);

  const projectAssetLibrarySections = useMemo(
    () => [
      { type: "CHARACTER" as const, label: "角色", assetLabel: "角色三视图", empty: "暂无角色资产", icon: UserRound },
      { type: "SCENE" as const, label: "场景", assetLabel: "场景图", empty: "暂无场景资产", icon: Building2 },
      { type: "PROP" as const, label: "道具", assetLabel: "道具图", empty: "暂无道具资产", icon: Package },
      { type: "STYLE" as const, label: "风格", assetLabel: "风格参考", empty: "暂无风格资产", icon: Boxes },
    ].map((section) => ({
      ...section,
      entities: getProjectVisualEntities(project, section.type),
      assetCount: getProjectVisualEntities(project, section.type).reduce(
        (count, entity) => count + getEntityVisualAssets(project, entity).length,
        0,
      ),
    })),
    [project],
  );

  const activeAssetLibrarySection =
    projectAssetLibrarySections.find((section) => section.type === activeAssetType) || projectAssetLibrarySections[0];
  const storyboardGeneratingShotSet = useMemo(
    () => new Set(storyboardGeneratingShotNumbers),
    [storyboardGeneratingShotNumbers],
  );
  const isStoryboardGenerating = storyboardGeneratingShotNumbers.length > 0;

  useEffect(() => {
    let active = true;
    setLoadingList(true);
    setListError("");

    fetch("/api/projects", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (!data.ok) throw new Error(data.error || "项目列表加载失败");
        const items = Array.isArray(data.projects) ? data.projects : [];
        setProjects(items);
        if (items[0]?.id) setSelectedProjectId(items[0].id);
      })
      .catch((err) => {
        if (active) setListError(err.message || "项目列表加载失败");
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });

    return () => {
      active = false;
    };
  }, []);

  async function reloadSelectedProject(projectId = selectedProjectId, preferredVersionId = selectedVersionId) {
    if (!projectId) {
      setProject(null);
      setProjectDetailError("");
      return;
    }

    setLoadingDetail(true);
    setProjectDetailError("");
    try {
      const res = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "项目详情加载失败");
      const nextProject = data.project || null;
      const versions = Array.isArray(nextProject?.versions) ? nextProject.versions : [];
      setProject(nextProject);
      setSelectedVersionId(
        versions.find((version: ProjectVersion) => version.id === preferredVersionId)?.id || versions[0]?.id || "",
      );
    } catch (err) {
      setProject(null);
      setProjectDetailError(getFriendlyProjectError(err instanceof Error ? err.message : "项目详情加载失败"));
    } finally {
      setLoadingDetail(false);
    }
  }

  useEffect(() => {
    void reloadSelectedProject(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  useEffect(() => {
    setProjectDetailView("episodes");
    setActiveAssetType("CHARACTER");
  }, [selectedProjectId]);

  function resumeEditing() {
    if (!project || !selectedVersion) return;
    window.localStorage.removeItem("vd_new_episode");
    window.localStorage.setItem("vd_resume_script", selectedVersion.originalScript || project.originalScript || "");
    window.localStorage.setItem("vd_resume_project_id", project.id);
    window.localStorage.setItem("vd_resume_version_id", selectedVersion.id);
    window.location.href = "/dashboard";
  }

  function clearDashboardProjectContext() {
    window.localStorage.removeItem("vd_resume_script");
    window.localStorage.removeItem("vd_resume_project_id");
    window.localStorage.removeItem("vd_resume_version_id");
    window.localStorage.removeItem("vd_new_episode");
  }

  function startNewProject() {
    clearDashboardProjectContext();
    window.location.href = "/dashboard";
  }

  function startNewEpisode() {
    if (!project?.id) {
      startNewProject();
      return;
    }
    window.localStorage.removeItem("vd_resume_script");
    window.localStorage.removeItem("vd_resume_version_id");
    window.localStorage.setItem("vd_resume_project_id", project.id);
    window.localStorage.setItem("vd_new_episode", "1");
    window.location.href = "/dashboard";
  }

  async function copyPrompt() {
    if (!selectedVersion) return;
    await navigator.clipboard.writeText(buildPromptText(selectedVersion));
  }

  function clampPromptDownloadRangeValue(value: number) {
    if (!Number.isFinite(value)) return selectedVersion?.versionNumber || minPromptDownloadVersion;
    return Math.min(maxPromptDownloadVersion, Math.max(minPromptDownloadVersion, Math.round(value)));
  }

  function getPromptDownloadVersions() {
    const start = Math.min(promptDownloadRangeStart, promptDownloadRangeEnd);
    const end = Math.max(promptDownloadRangeStart, promptDownloadRangeEnd);
    return sortedProjectVersions.filter((version) => version.versionNumber >= start && version.versionNumber <= end);
  }

  function setPromptDownloadRange(range: "current" | "all" | "first5" | "last5") {
    if (!sortedProjectVersions.length) return;
    if (range === "current" && selectedVersion) {
      setPromptDownloadRangeStart(selectedVersion.versionNumber);
      setPromptDownloadRangeEnd(selectedVersion.versionNumber);
      return;
    }
    if (range === "all") {
      setPromptDownloadRangeStart(minPromptDownloadVersion);
      setPromptDownloadRangeEnd(maxPromptDownloadVersion);
      return;
    }

    const targetVersions = range === "first5" ? sortedProjectVersions.slice(0, 5) : sortedProjectVersions.slice(-5);
    setPromptDownloadRangeStart(targetVersions[0]?.versionNumber || minPromptDownloadVersion);
    setPromptDownloadRangeEnd(targetVersions[targetVersions.length - 1]?.versionNumber || maxPromptDownloadVersion);
  }

  async function downloadPromptDocx(mode: "complete" | "review") {
    if (!project || !selectedVersion) return;
    const promptDownloadVersions = getPromptDownloadVersions();
    const sections = promptDownloadVersions
      .map((version) => ({
        heading: `${version.title} 第${version.versionNumber}段`,
        originalText: mode === "review" ? version.originalScript : "",
        promptText: buildPromptText(version),
      }))
      .filter((section) => section.promptText.trim());

    if (!sections.length) {
      setProjectDetailError("所选范围内没有可下载的提示词。");
      return;
    }

    const downloadStart = Math.min(...promptDownloadVersions.map((version) => version.versionNumber));
    const downloadEnd = Math.max(...promptDownloadVersions.map((version) => version.versionNumber));
    const selectedSegmentDownloadTitle = `${selectedVersion.title}-第${selectedVersion.versionNumber}段`;
    const downloadKindTitle = mode === "review" ? "审阅版" : "完整提示词";
    let downloadTitle = `${project.title}-第${downloadStart}-${downloadEnd}段-${downloadKindTitle}`;
    if (downloadStart === downloadEnd) {
      downloadTitle =
        promptDownloadVersions[0]?.id === selectedVersion.id
          ? `${selectedSegmentDownloadTitle}-${downloadKindTitle}`
          : `${project.title}-第${downloadStart}段-${downloadKindTitle}`;
    }

    const res = await fetch("/api/prompt-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: downloadTitle,
        sections,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setProjectDetailError(data?.error || "DOCX 下载失败");
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${downloadTitle}.docx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setPromptDownloadPanelOpen(false);
  }

  function storyboardCodexPanels(job: StoryboardCodexJob) {
    return Object.fromEntries(
      job.panels
        .filter((panel) => typeof panel.imageUrl === "string" && panel.imageUrl.length > 0)
        .map((panel) => [panel.shotNumber, panel.imageUrl as string]),
    ) as Record<number, string>;
  }

  function calculateProjectStoryboardCodexTimeoutMs(job: StoryboardCodexJob) {
    return Math.max(30 * 60_000, job.panels.length * 8 * 60_000);
  }

  async function createProjectStoryboardCodexJob(version: ProjectVersion, shots: ProjectShot[]) {
    if (!project) throw new Error("项目详情未加载完成");
    if (!shots.length) throw new Error("本段没有可生成的镜头");

    const res = await fetch("/api/storyboard-image/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        versionId: version.id,
        title: `${project.title} 第${version.versionNumber}段`,
        style: `${version.style || project.style || "电影级分镜"}，16:9 彩色电影级分镜图，电影光影，写实概念美术`,
        storyboard: shots.map(mapProjectShotToStoryboardJobShot),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Codex 分镜图任务创建失败");
    return data.job as StoryboardCodexJob;
  }

  async function pollProjectStoryboardCodexJob(jobId: string, savedPanelIds = new Set<string>()) {
    const startedAt = Date.now();
    let timeoutMs = 30 * 60_000;
    const pollMs = 2500;
    let failedPollCount = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/storyboard-image/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Codex 分镜图任务查询失败");

      const job = data.job as StoryboardCodexJob;
      timeoutMs = calculateProjectStoryboardCodexTimeoutMs(job);
      const savedNow = await saveProjectStoryboardVisualAssets(job, savedPanelIds);
      if (savedNow.length && project?.id) {
        await reloadSelectedProject(project.id, selectedVersion?.id);
      }

      const completed = job.panels.filter((panel) => panel.status === "completed").length;
      const running = job.panels.filter((panel) => panel.status === "running").length;
      const retrying = getRetryingStoryboardPanelCount(job);
      const failed = job.panels.filter((panel) => panel.status === "failed").length;
      setStoryboardGenerationMessage(
        running
          ? `镜头分镜图生成中：${completed}/${job.panels.length} 已完成，${running} 张处理中。`
          : retrying
            ? `镜头分镜图生成中：${completed}/${job.panels.length} 已完成，${retrying} 张正在自动重试。`
            : failed
              ? `镜头分镜图状态确认中：${completed}/${job.panels.length} 已完成，${failed} 张暂时失败。`
              : `镜头分镜图排队中：${completed}/${job.panels.length} 已完成。`,
      );

      if (job.status === "completed") return job;
      if (job.status === "failed") {
        failedPollCount += 1;
        if (failedPollCount >= STORYBOARD_FAILED_GRACE_POLLS) {
          throw new Error(getFailedStoryboardPanelMessage(job));
        }
      } else {
        failedPollCount = 0;
      }

      await new Promise((resolve) => window.setTimeout(resolve, pollMs));
    }

    throw new Error("Codex 分镜图任务等待超时，请确认 storyboard:codex-worker 正在运行。");
  }

  async function saveProjectStoryboardVisualAssets(job: StoryboardCodexJob, savedPanelIds = new Set<string>()) {
    if (!project || !selectedVersion) return [];

    const completedPanels = job.panels
      .filter((panel) => panel.status === "completed" && typeof panel.imageUrl === "string" && panel.imageUrl.length > 0)
      .filter((panel) => !savedPanelIds.has(panel.id));

    const visualAssets = completedPanels
      .map((panel) => ({
        type: "SHOT_STORYBOARD",
        name: `镜头 ${panel.shotNumber} 分镜图`,
        shotNumber: panel.shotNumber,
        variantKey: `shot-${panel.shotNumber}-storyboard-primary`,
        prompt: panel.prompt || job.prompt || "",
        imageUrl: panel.imageUrl,
        status: "COMPLETED",
        isPrimary: true,
        metadata: {
          source: "codex-imagegen",
          generatedFrom: "projects-page",
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
        projectId: project.id,
        versionId: selectedVersion.id,
        visualAssets,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "镜头分镜图保存失败");

    completedPanels.forEach((panel) => savedPanelIds.add(panel.id));
    return data.save?.visualAssets || [];
  }

  async function runProjectStoryboardGeneration(version: ProjectVersion, shots: ProjectShot[]) {
    if (!project) return;
    setStoryboardGeneratingShotNumbers(shots.map((shot) => shot.shotNumber));
    setStoryboardGenerationError("");
    setStoryboardGenerationMessage(`已创建 ${shots.length} 张镜头分镜图任务，请确认 storyboard:codex-worker 正在运行。`);

    const savedPanelIds = new Set<string>();

    try {
      const job = await createProjectStoryboardCodexJob(version, shots);
      const completedJob = await pollProjectStoryboardCodexJob(job.id, savedPanelIds);
      const panels = storyboardCodexPanels(completedJob);
      if (!Object.keys(panels).length) throw new Error("Codex 分镜图任务完成但没有生成镜头图片");
      await saveProjectStoryboardVisualAssets(completedJob, savedPanelIds);
      await reloadSelectedProject(project.id, selectedVersion?.id || version.id);
      setStoryboardGenerationMessage("镜头分镜图生成完成，已保存到本段镜头表。");
    } catch (err) {
      if (savedPanelIds.size > 0) {
        await reloadSelectedProject(project.id, selectedVersion?.id || version.id).catch(() => undefined);
      }
      const message = getFriendlyProjectError(err instanceof Error ? err.message : "镜头分镜图生成失败");
      setStoryboardGenerationError(
        savedPanelIds.size > 0 ? `${message}。已保留 ${savedPanelIds.size} 张已完成分镜图。` : message,
      );
    } finally {
      setStoryboardGeneratingShotNumbers([]);
    }
  }

  async function generateEpisodeStoryboards() {
    if (!selectedVersion) return;
    await runProjectStoryboardGeneration(selectedVersion, getEpisodeStoryboardTargetShots(selectedVersion));
  }

  async function regenerateShotStoryboard(shot: ProjectShot) {
    if (!selectedVersion) return;
    await runProjectStoryboardGeneration(selectedVersion, [shot]);
  }

  async function createVisualAssetCodexJob(entity: ProjectVisualEntity) {
    if (!project || !selectedVersion) throw new Error("项目详情未加载完成");
    const entityAssets = getEntityVisualAssets(project, entity);
    const res = await fetch("/api/visual-asset-image/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        versionId: selectedVersion.id,
        entityId: entity.id,
        entityType: entity.type,
        entityName: entity.name,
        entityKey: entity.key,
        canonicalPrompt: entity.canonicalPrompt || undefined,
        visualLock: entity.visualLock || undefined,
        negativeLock: entity.negativeLock || undefined,
        mode: entityAssets.length ? "regenerate" : "initial",
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "视觉资产图任务创建失败");
    return data.job as VisualAssetCodexJob;
  }

  async function pollVisualAssetCodexJob(jobId: string) {
    const startedAt = Date.now();
    const timeoutMs = 30 * 60_000;
    const pollMs = 2500;

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/visual-asset-image/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "视觉资产图任务查询失败");

      const job = data.job as VisualAssetCodexJob;
      setVisualAssetGenerationMessage(
        job.status === "running"
          ? `正在生成 ${job.entityName} 的资产图...`
          : `视觉资产图任务状态：${job.status}`,
      );
      if (job.status === "completed") return job;
      if (job.status === "failed") {
        throw new Error(job.error || job.task?.error || "视觉资产图生成失败");
      }
      await new Promise((resolve) => window.setTimeout(resolve, pollMs));
    }

    throw new Error("视觉资产图任务等待超时，请确认 visual-asset:codex-worker 正在运行。");
  }

  async function saveGeneratedVisualAsset(entity: ProjectVisualEntity, job: VisualAssetCodexJob) {
    if (!project || !selectedVersion || !job.task?.imageUrl) return;
    const existingAssets = getEntityVisualAssets(project, entity);
    const assetType = getVisualAssetTypeForEntity(entity.type);
    const res = await fetch("/api/projects/visual-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        versionId: selectedVersion.id,
        visualAssets: [
          {
            type: assetType,
            name: `${entity.name} ${assetType === "CHARACTER_TURNAROUND" ? "角色三视图" : assetType === "PROP_SHEET" ? "道具图" : "场景图"}`,
            entityId: entity.id,
            variantKey: `${entity.key || entity.id}-${job.mode}-${Date.now()}`,
            prompt: job.task.prompt || "",
            imageUrl: job.task.imageUrl,
            status: "COMPLETED",
            isPrimary: existingAssets.length === 0,
            locked: entity.status === "LOCKED",
            metadata: {
              source: "codex-imagegen",
              generatedFrom: "project-asset-library",
              jobId: job.id,
              taskId: job.task.id,
              entityType: entity.type,
              entityKey: entity.key,
              assetType,
              mode: job.mode,
              size: job.task.size,
              quality: job.task.quality,
              attempts: job.task.attempts,
              sourceImagePath: job.task.sourceImagePath,
              codexLogPath: job.task.codexLogPath,
            },
          },
        ],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "视觉资产图保存失败");
  }

  async function generateProjectVisualEntityAsset(entity: ProjectVisualEntity) {
    if (!project || !selectedVersion || visualAssetGeneratingEntityId) return;
    setVisualAssetGeneratingEntityId(entity.id);
    setVisualAssetGenerationError("");
    setVisualAssetGenerationMessage(`已创建 ${entity.name} 的资产图任务，请确认 visual-asset:codex-worker 正在运行。`);

    try {
      const job = await createVisualAssetCodexJob(entity);
      const completedJob = await pollVisualAssetCodexJob(job.id);
      await saveGeneratedVisualAsset(entity, completedJob);
      await reloadSelectedProject(project.id, selectedVersion.id);
      setVisualAssetGenerationMessage(`${entity.name} 的资产图已生成并保存到资产库。`);
    } catch (err) {
      setVisualAssetGenerationError(getFriendlyProjectError(err instanceof Error ? err.message : "视觉资产图生成失败"));
    } finally {
      setVisualAssetGeneratingEntityId("");
    }
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
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Seedance 合规优化任务创建失败");
    return data.job as PromptSafetyCodexJob;
  }

  async function pollPromptSafetyCodexJob(jobId: string) {
    const startedAt = Date.now();
    const timeoutMs = 20 * 60_000;
    let lastStatus = "";

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/prompt-safety/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Seedance 合规优化任务读取失败");

      const currentJob = data.job as PromptSafetyCodexJob;
      if (currentJob.status !== lastStatus) {
        lastStatus = currentJob.status;
        setPromptSafetyMessage(
          currentJob.status === "running"
            ? "Codex 正在本地优化本段 Seedance 2.0 合规提示词..."
            : `Seedance 合规优化任务状态：${currentJob.status}`,
        );
      }
      if (currentJob.status === "completed") return currentJob;
      if (currentJob.status === "failed") throw new Error(currentJob.error || "Seedance 合规优化任务失败");
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }

    throw new Error("Seedance 合规优化任务等待超时，请确认 prompt-safety:codex-worker 正在运行。");
  }

  async function runProjectPromptSafetyOptimization() {
    if (!project || !selectedVersion) return;
    setPromptSafetyLoading(true);
    setPromptSafetyError("");
    setPromptSafetyMessage("已创建本段 Seedance 合规优化准备任务，请确认 prompt-safety:codex-worker 正在运行。");

    try {
      const sourceResult = buildAnalysisResultFromProjectVersion(project, selectedVersion);
      const job = await createPromptSafetyCodexJob(sourceResult, buildPromptText(selectedVersion), project.id, selectedVersion.id);
      const completedJob = await pollPromptSafetyCodexJob(job.id);
      const safetyResult = completedJob.result;
      const optimizedResult = safetyResult?.optimizedResult;
      if (!safetyResult || !optimizedResult) throw new Error("Seedance 合规优化完成但没有返回优化结果");
      if (safetyResult.status === "BLOCKED_NEEDS_USER_EDIT") {
        const reason = safetyResult.findings.map((finding) => finding.reason).filter(Boolean).join("；");
        throw new Error(reason || "当前本段提示词无法自动合规改写，需要先调整文案");
      }

      const optimizedPromptText = buildAnalysisResultPromptText(optimizedResult);
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          versionId: selectedVersion.id,
          originalScript: selectedVersion.originalScript,
          result: optimizedResult,
          fullVideoPrompt: optimizedPromptText,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Seedance 合规优化结果保存失败");

      await reloadSelectedProject(project.id, selectedVersion.id);
      setPromptSafetyMessage(
        `Seedance 合规优化完成并已应用到本段：${safetyResult.findings.length} 处风险记录，${safetyResult.changeSummary.length} 条修改说明。`,
      );
    } catch (err) {
      setPromptSafetyError(getFriendlyProjectError(err instanceof Error ? err.message : "Seedance 合规优化失败"));
    } finally {
      setPromptSafetyLoading(false);
    }
  }

  function formatPromptQualityIssue(issue: SegmentPromptQualityIssue) {
    const target = issue.shotNumber ? `镜头 ${issue.shotNumber}` : "本段";
    return `${target}｜${issue.label}：${issue.detail}`;
  }

  function buildProjectPromptRepairScript(
    sourceResult: AnalysisResult,
    currentPromptText: string,
    qualityIssues: SegmentPromptQualityIssue[],
    repairInstruction: string,
  ) {
    const issueText = qualityIssues.length
      ? qualityIssues.map((issue, index) => `${index + 1}. ${formatPromptQualityIssue(issue)}`).join("\n")
      : "用户主动要求优化当前段。";

    return [
      `你正在修复 Local Director 已保存的第 ${selectedVersion?.versionNumber || 1} 段视频提示词。`,
      "",
      "修复边界：",
      "1. 只修当前段，不新增段，不删除段，不改项目标题，不改段号。",
      "2. 保留原剧情、人物关系、段尾承接、时长上限和镜头顺序。",
      "3. 不重写成新故事，不输出解释、报告、Markdown 或修改清单。",
      "4. 如果没有台词，dialogue 必须写“无”。",
      "5. 用户侧统一使用“段”，不要写“集 / 本集 / 单集 / 剧集”。",
      "6. 修复后仍然输出完整 AnalysisResult JSON。",
      "",
      "检测到的问题：",
      issueText,
      "",
      "用户想怎么修改：",
      repairInstruction.trim() || "按检测到的问题修复硬错误，并保持原提示词质量和内容厚度。",
      "",
      "当前完整提示词：",
      currentPromptText,
      "",
      "当前结构化结果 JSON：",
      JSON.stringify(sourceResult, null, 2),
    ].join("\n");
  }

  async function createProjectPromptRepairCodexJob(
    sourceResult: AnalysisResult,
    repairInstruction: string,
    qualityIssues: SegmentPromptQualityIssue[],
  ) {
    if (!project || !selectedVersion) throw new Error("请选择要修复的项目段落。");
    const currentPromptText = buildPromptText(selectedVersion);
    const res = await fetch("/api/video-prompt/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        versionId: selectedVersion.id,
        script: buildProjectPromptRepairScript(sourceResult, currentPromptText, qualityIssues, repairInstruction),
        contentType: selectedVersion.contentType || project.contentType || undefined,
        style: selectedVersion.style || project.style || undefined,
        duration: selectedVersion.duration || project.duration || "auto",
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "本段提示词修复任务创建失败");
    return data.job as VideoPromptCodexJob;
  }

  async function pollProjectPromptRepairCodexJob(jobId: string) {
    const startedAt = Date.now();
    const timeoutMs = 20 * 60_000;
    let lastStatus = "";

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`/api/video-prompt/jobs/${jobId}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "本段提示词修复任务读取失败");

      const currentJob = data.job as VideoPromptCodexJob;
      if (currentJob.status !== lastStatus) {
        lastStatus = currentJob.status;
        setPromptRepairMessage(
          currentJob.status === "running"
            ? "Codex 正在本地修复本段视频提示词..."
            : `本段提示词修复任务状态：${currentJob.status}`,
        );
      }
      if (currentJob.status === "completed") return currentJob;
      if (currentJob.status === "failed") throw new Error(currentJob.error || "本段提示词修复任务失败");
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }

    throw new Error("本段提示词修复任务等待超时，请确认 video-prompt:codex-worker 正在运行。");
  }

  function assertProjectPromptRepairResult(value: unknown): AnalysisResult {
    const result = value as AnalysisResult | null | undefined;
    if (!result || typeof result !== "object") throw new Error("修复完成但没有返回结构化结果。");
    if (!Array.isArray(result.storyboard) || !result.storyboard.length) {
      throw new Error("修复结果缺少 storyboard。");
    }
    if (!result.optimizedScript || !result.workflow?.fullVideoPrompt) {
      throw new Error("修复结果缺少 optimizedScript 或 workflow.fullVideoPrompt。");
    }
    return result;
  }

  async function runProjectPromptRepair() {
    if (!project || !selectedVersion || promptRepairLoading) return;
    setPromptRepairLoading(true);
    setPromptRepairError("");
    setPromptRepairMessage("已创建本段提示词修复准备任务，请确认 video-prompt:codex-worker 正在运行。");

    try {
      const sourceResult = buildAnalysisResultFromProjectVersion(project, selectedVersion);
      const job = await createProjectPromptRepairCodexJob(
        sourceResult,
        promptRepairInstruction,
        selectedVersionQualityIssues,
      );
      const completedJob = await pollProjectPromptRepairCodexJob(job.id);
      const repairedResult = assertProjectPromptRepairResult(completedJob.result);
      const repairedPromptText = buildAnalysisResultPromptText(repairedResult);
      const repairedIssues = analyzeSegmentPromptQuality({
        segmentNumber: selectedVersion.versionNumber,
        title: repairedResult.title,
        duration: repairedResult.duration,
        fullVideoPrompt: repairedPromptText,
        optimizedScript: repairedResult.optimizedScript,
        shots: repairedResult.storyboard as unknown as Array<Record<string, unknown>>,
      });
      const blockingIssues = repairedIssues.filter((issue) => issue.severity === "blocking");
      if (blockingIssues.length) {
        throw new Error(`修复结果仍有硬错误：${blockingIssues.map(formatPromptQualityIssue).join("；")}`);
      }

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          versionId: selectedVersion.id,
          originalScript: selectedVersion.originalScript,
          result: repairedResult,
          fullVideoPrompt: repairedPromptText,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "本段提示词修复结果保存失败");

      await reloadSelectedProject(project.id, selectedVersion.id);
      setPromptRepairInstruction("");
      setPromptRepairMessage("本段提示词已修复并保存。");
    } catch (err) {
      setPromptRepairError(getFriendlyProjectError(err instanceof Error ? err.message : "本段提示词修复失败"));
    } finally {
      setPromptRepairLoading(false);
    }
  }

  function toggleProjectChecked(projectId: string) {
    setCheckedProjectIds((ids) =>
      ids.includes(projectId) ? ids.filter((id) => id !== projectId) : [...ids, projectId],
    );
  }

  function handleProjectClick(projectId: string) {
    if (deleteMode) {
      toggleProjectChecked(projectId);
      return;
    }
    setSelectedProjectId(projectId);
  }

  async function deleteCheckedProjects() {
    if (!deleteMode) {
      setDeleteMode(true);
      setCheckedProjectIds([]);
      return;
    }

    if (!checkedProjectIds.length) {
      setDeleteMode(false);
      return;
    }

    if (!window.confirm(`确定彻底删除 ${checkedProjectIds.length} 个项目吗？`)) return;

    setDeletingProjects(true);
    setListError("");
    try {
      await Promise.all(
        checkedProjectIds.map(async (projectId) => {
          const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
          const data = await res.json().catch(() => null);
          if (!res.ok || !data?.ok) throw new Error(data?.error || "项目删除失败");
        }),
      );

      const remainingProjects = projects.filter((item) => !checkedProjectIds.includes(item.id));
      const nextSelectedId =
        remainingProjects.find((item) => item.id === selectedProjectId)?.id || remainingProjects[0]?.id || "";

      setProjects(remainingProjects);
      setCheckedProjectIds([]);
      setDeleteMode(false);
      setSelectedProjectId(nextSelectedId);
      if (!nextSelectedId) {
        setProject(null);
        setSelectedVersionId("");
        setProjectDetailError("");
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : "项目删除失败");
    } finally {
      setDeletingProjects(false);
    }
  }

  async function deleteSelectedEpisode() {
    if (!project || !selectedVersion) return;
    if (!window.confirm(`确定删除第 ${selectedVersion.versionNumber} 段吗？后面的段数会自动补位。`)) return;

    setDeletingEpisode(true);
    setProjectDetailError("");
    try {
      const res = await fetch(`/api/projects/${project.id}?versionId=${selectedVersion.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "分段删除失败");
      await reloadSelectedProject(project.id);
    } catch (err) {
      setProjectDetailError(err instanceof Error ? err.message : "分段删除失败");
    } finally {
      setDeletingEpisode(false);
    }
  }

  async function patchProjectSubPath(subPath: string, body: Record<string, unknown>) {
    if (!project) return;
    setProjectDetailError("");
    const res = await fetch(`/api/projects/${project.id}/${subPath}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "记忆更新失败");
    await reloadSelectedProject(project.id);
  }

  async function editStoryBible() {
    if (!project) return;
    const next = window.prompt("编辑 storyBible JSON", formatJson(project.storyBible || {}));
    if (next === null) return;
    try {
      await patchProjectSubPath("memory", { storyBible: parseJsonOrThrow(next) });
    } catch (err) {
      setProjectDetailError(err instanceof Error ? err.message : "记忆更新失败");
    }
  }

  async function editCharacter(character: CharacterProfile) {
    if (!project) return;
    const next = window.prompt("编辑角色视觉锁定", character.visualLock || character.appearance || "");
    if (next === null) return;
    try {
      await patchProjectSubPath(`characters/${character.id}`, { visualLock: next, locked: true });
    } catch (err) {
      setProjectDetailError(err instanceof Error ? err.message : "角色更新失败");
    }
  }

  async function resolveStoryLoop(loop: StoryLoop) {
    if (!project) return;
    try {
      await patchProjectSubPath(`story-loops/${loop.id}`, { status: "RESOLVED" });
    } catch (err) {
      setProjectDetailError(err instanceof Error ? err.message : "伏笔更新失败");
    }
  }

  async function toggleMemory(memory: MemoryItem) {
    if (!project) return;
    try {
      await patchProjectSubPath(`memories/${memory.id}`, { isEnabled: !memory.isEnabled });
    } catch (err) {
      setProjectDetailError(err instanceof Error ? err.message : "记忆更新失败");
    }
  }

  const promptDownloadVersions = getPromptDownloadVersions();
  const promptDownloadStartDisplay = Math.min(promptDownloadRangeStart, promptDownloadRangeEnd);
  const promptDownloadEndDisplay = Math.max(promptDownloadRangeStart, promptDownloadRangeEnd);

  return (
    <div className="projects-page-shell relative min-h-[calc(100vh-4rem)] text-slate-100">
      {listError && (
        <div className="mb-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">
          {listError === "Unauthorized" ? (
            <span>
              请先登录后查看项目。
              <a className="ml-2 font-semibold text-cyan-100 underline" href="/login">
                去登录
              </a>
            </span>
          ) : (
            listError
          )}
        </div>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="projects-list-panel min-w-0 rounded-2xl p-3">
          <div className="projects-list-toolbar mb-3 flex items-center justify-between gap-2 px-2 pt-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="shrink-0 font-bold text-white">项目列表</h2>
              {loadingList && <Loader2 className="h-4 w-4 animate-spin text-cyan-100" />}
            </div>
            <div className="projects-list-actions flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={deleteCheckedProjects}
                disabled={deletingProjects}
                title={deleteMode ? "确认删除或取消删除模式" : "进入项目删除模式"}
                className={`projects-list-action-button ${
                  deleteMode
                    ? "projects-list-action-danger"
                    : ""
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {deletingProjects ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                <span>{deleteMode ? (checkedProjectIds.length ? `删除 ${checkedProjectIds.length}` : "取消") : "删除"}</span>
              </button>
              <button
                type="button"
                onClick={startNewProject}
                title="新建生成"
                className="projects-list-action-button projects-list-action-primary"
              >
                <Edit3 className="h-3.5 w-3.5" />
                <span>新建生成</span>
              </button>
            </div>
          </div>

          {deleteMode && (
            <p className="mb-3 px-2 text-xs text-red-100/75">
              删除模式：点击项目右侧的框勾选，再点击列表右上角删除。
            </p>
          )}

          {!loadingList && !projects.length && (
            <div className="rounded-xl border border-dashed border-cyan-300/16 bg-slate-950/60 p-4 text-sm leading-6 text-slate-400">
              还没有保存的项目。去工作台生成一次后，这里会自动出现历史记录。
            </div>
          )}

          <div className="projects-list-scroll space-y-2 pr-1">
            {projects.map((item) => {
              const active = item.id === selectedProjectId;
              const checked = checkedProjectIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  onClick={() => handleProjectClick(item.id)}
                  className={`projects-list-item w-full rounded-xl p-3 text-left ${
                    active
                      ? "projects-list-item-active"
                      : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-bold text-white">{item.title}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {item.content_type || "自动分类"} · {item.duration || "-"}
                      </div>
                    </div>
                    {deleteMode && (
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-xs font-bold ${
                          checked
                            ? "border-cyan-200/50 bg-cyan-300/25 text-cyan-50"
                            : "border-white/15 bg-white/[0.03] text-transparent"
                        }`}
                      >
                        ✓
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {formatDate(item.created_at)}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="projects-detail-panel min-w-0 min-h-[520px] rounded-2xl p-5 md:p-6">
          {loadingDetail && (
            <div className="flex h-80 items-center justify-center gap-3 text-sm text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin text-cyan-100" />
              正在加载项目详情...
            </div>
          )}

          {!loadingDetail && projectDetailError && (
            <div className="flex min-h-[420px] items-center justify-center">
              <div className="max-w-md rounded-2xl border border-red-400/20 bg-red-500/10 p-5 text-sm leading-7 text-red-50">
                <div className="mb-2 font-bold text-white">项目详情加载失败</div>
                <p>{projectDetailError}</p>
                <button
                  type="button"
                  onClick={() => reloadSelectedProject()}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-200/20 bg-white/[0.04] px-3 py-2 font-semibold text-white transition hover:bg-white/[0.08]"
                >
                  <RefreshCw className="h-4 w-4" />
                  重试
                </button>
              </div>
            </div>
          )}

          {!loadingDetail && !projectDetailError && !project && projects.length > 0 && (
            <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-cyan-300/16 bg-slate-950/40 text-sm text-slate-500">
              请选择左侧项目查看详情。
            </div>
          )}

          {!loadingDetail && !projectDetailError && project && selectedVersion && (
            <div className="min-w-0 space-y-5">
              <div className="projects-project-stepper" role="tablist" aria-label="项目工作流">
                <button
                  type="button"
                  role="tab"
                  aria-selected={projectDetailView === "episodes"}
                  onClick={() => setProjectDetailView("episodes")}
                  className={`projects-stepper-item ${
                    projectDetailView === "episodes"
                      ? "projects-stepper-active"
                      : projectDetailView === "assets"
                        ? "projects-stepper-complete"
                        : ""
                  }`}
                >
                  <span className="projects-stepper-number">
                    {projectDetailView === "assets" ? <Check className="h-3.5 w-3.5" /> : "1"}
                  </span>
                  <BookOpen className="h-4 w-4" />
                  <span>分段</span>
                </button>
                <span className="projects-stepper-connector" aria-hidden="true" />
                <button
                  type="button"
                  role="tab"
                  aria-selected={projectDetailView === "assets"}
                  onClick={() => setProjectDetailView("assets")}
                  className={`projects-stepper-item ${projectDetailView === "assets" ? "projects-stepper-active" : ""}`}
                >
                  <span className="projects-stepper-number">2</span>
                  <Boxes className="h-4 w-4" />
                  <span>资产库</span>
                </button>
                <span className="projects-stepper-connector" aria-hidden="true" />
                <button
                  type="button"
                  className="projects-stepper-item projects-stepper-disabled"
                  disabled
                  title="后续接入分段视频生成"
                >
                  <span className="projects-stepper-number">3</span>
                  <Clapperboard className="h-4 w-4" />
                  <span>分段视频</span>
                </button>
              </div>

              <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-wide text-cyan-200/70">Saved Project</div>
                  <h2 className="mt-1 text-2xl font-black text-white">{project.title}</h2>
                  <p className="mt-2 text-sm text-slate-500">
                    {project.contentType || "自动分类"} · {project.style || "自动风格"} · {project.duration || "-"}
                  </p>
                </div>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <button
                    onClick={resumeEditing}
                    className="projects-action-button projects-action-primary"
                  >
                    <RefreshCw className="h-4 w-4" />
                    继续编辑
                  </button>
                  <button
                    onClick={startNewEpisode}
                    className="projects-action-button"
                  >
                    <Edit3 className="h-4 w-4" />
                    新建一段
                  </button>
                  <button
                    onClick={generateEpisodeStoryboards}
                    disabled={isStoryboardGenerating || !selectedVersion.shots.length}
                    className="projects-action-button disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isStoryboardGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                    {isStoryboardGenerating ? "正在生成分镜图" : getEpisodeStoryboardActionLabel(selectedVersion)}
                  </button>
                  <button
                    onClick={runProjectPromptSafetyOptimization}
                    disabled={promptSafetyLoading}
                    className="projects-action-button disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {promptSafetyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {promptSafetyLoading ? "正在合规优化" : "Seedance 合规优化"}
                  </button>
                  <button
                    onClick={runProjectPromptRepair}
                    disabled={promptRepairLoading || promptSafetyLoading}
                    className="projects-action-button disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {promptRepairLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                    {promptRepairLoading ? "正在修复本段" : "修复本段"}
                  </button>
                  <button
                    onClick={deleteSelectedEpisode}
                    disabled={deletingEpisode}
                    className="projects-action-button projects-action-danger disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {deletingEpisode ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    删除本段
                  </button>
                  <button
                    onClick={copyPrompt}
                    className="projects-action-button"
                  >
                    <Copy className="h-4 w-4" />
                    复制提示词
                  </button>
                  <button
                    onClick={() => setPromptDownloadPanelOpen((open) => !open)}
                    className="projects-action-button"
                    aria-expanded={promptDownloadPanelOpen}
                  >
                    <Download className="h-4 w-4" />
                    下载提示词
                  </button>
                </div>
              </div>

              {promptDownloadPanelOpen && (
                <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.06] p-4">
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold uppercase tracking-wide text-cyan-200/70">Prompt DOCX</div>
                      <div className="mt-1 text-sm font-bold text-white">选择要下载的提示词范围</div>
                      <p className="mt-1 text-xs leading-5 text-slate-400">
                        当前项目共 {project.versions.length} 段，将下载第 {promptDownloadStartDisplay} -{" "}
                        {promptDownloadEndDisplay} 段，共 {promptDownloadVersions.length} 段。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPromptDownloadRange("current")}
                        className="rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-200/40 hover:text-cyan-50"
                      >
                        当前段
                      </button>
                      <button
                        type="button"
                        onClick={() => setPromptDownloadRange("all")}
                        className="rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-200/40 hover:text-cyan-50"
                      >
                        全部
                      </button>
                      <button
                        type="button"
                        onClick={() => setPromptDownloadRange("first5")}
                        className="rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-200/40 hover:text-cyan-50"
                      >
                        前 5 段
                      </button>
                      <button
                        type="button"
                        onClick={() => setPromptDownloadRange("last5")}
                        className="rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-200/40 hover:text-cyan-50"
                      >
                        后 5 段
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-end gap-3">
                    <label className="min-w-28 text-xs font-semibold text-slate-300">
                      起始段
                      <input
                        type="number"
                        min={minPromptDownloadVersion}
                        max={maxPromptDownloadVersion}
                        value={promptDownloadRangeStart}
                        onChange={(event) =>
                          setPromptDownloadRangeStart(clampPromptDownloadRangeValue(Number(event.target.value)))
                        }
                        className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white outline-none transition focus:border-cyan-200/60"
                      />
                    </label>
                    <label className="min-w-28 text-xs font-semibold text-slate-300">
                      结束段
                      <input
                        type="number"
                        min={minPromptDownloadVersion}
                        max={maxPromptDownloadVersion}
                        value={promptDownloadRangeEnd}
                        onChange={(event) =>
                          setPromptDownloadRangeEnd(clampPromptDownloadRangeValue(Number(event.target.value)))
                        }
                        className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white outline-none transition focus:border-cyan-200/60"
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => downloadPromptDocx("complete")}
                        disabled={!promptDownloadVersions.length}
                        className="projects-action-button projects-action-primary disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Download className="h-4 w-4" />
                        下载完整提示词
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadPromptDocx("review")}
                        disabled={!promptDownloadVersions.length}
                        className="projects-action-button disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Download className="h-4 w-4" />
                        下载审阅版
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {(storyboardGenerationMessage || storyboardGenerationError) && (
                <div
                  className={`rounded-2xl border px-4 py-3 text-sm ${
                    storyboardGenerationError
                      ? "border-red-400/25 bg-red-500/10 text-red-100"
                      : "border-cyan-300/16 bg-cyan-300/[0.07] text-cyan-50"
                  }`}
                >
                  {storyboardGenerationError || storyboardGenerationMessage}
                </div>
              )}

              {(promptSafetyMessage || promptSafetyError) && (
                <div
                  className={`rounded-2xl border px-4 py-3 text-sm ${
                    promptSafetyError
                      ? "border-red-400/25 bg-red-500/10 text-red-100"
                      : "border-emerald-300/18 bg-emerald-400/10 text-emerald-50"
                  }`}
                >
                  {promptSafetyError || promptSafetyMessage}
                </div>
              )}

              {(promptRepairMessage || promptRepairError) && (
                <div
                  className={`rounded-2xl border px-4 py-3 text-sm ${
                    promptRepairError
                      ? "border-red-400/25 bg-red-500/10 text-red-100"
                      : "border-cyan-300/18 bg-cyan-400/10 text-cyan-50"
                  }`}
                >
                  {promptRepairError || promptRepairMessage}
                </div>
              )}

              {projectDetailView === "episodes" && (
                <div className="rounded-2xl border border-cyan-300/12 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-bold text-white">
                        <Wrench className="h-4 w-4 text-cyan-100" />
                        提示词质量检查
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-400">
                        当前项目有 {projectPromptQualityIssueCount} 条本地检查建议；本段有 {selectedVersionQualityIssues.length} 条。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={runProjectPromptRepair}
                      disabled={promptRepairLoading}
                      className="projects-action-button disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {promptRepairLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                      修复本段
                    </button>
                  </div>
                  {selectedVersionQualityIssues.length > 0 && (
                    <div className="mt-3 grid gap-2 text-xs leading-5 text-slate-300 sm:grid-cols-2">
                      {selectedVersionQualityIssues.slice(0, 6).map((issue) => (
                        <div
                          key={`${issue.code}-${issue.field || "segment"}-${issue.shotNumber || 0}`}
                          className={`rounded-xl border px-3 py-2 ${
                            issue.severity === "blocking"
                              ? "border-red-300/20 bg-red-500/10 text-red-100"
                              : "border-amber-200/20 bg-amber-400/10 text-amber-50"
                          }`}
                        >
                          {formatPromptQualityIssue(issue)}
                        </div>
                      ))}
                    </div>
                  )}
                  <label className="mt-3 block text-xs font-semibold text-slate-300">
                    你想怎么修改
                    <textarea
                      value={promptRepairInstruction}
                      onChange={(event) => setPromptRepairInstruction(event.target.value)}
                      rows={3}
                      placeholder="例如：保留剧情，只把第 3 镜头的画面写得更具体；修掉同上、undefined 或集数术语。"
                      className="mt-2 w-full resize-y rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm leading-6 text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-200/60"
                    />
                  </label>
                </div>
              )}

              {projectDetailView === "episodes" && (
                <>
              <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="projects-content-card min-w-0 rounded-2xl p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-bold text-white">
                    <FileText className="h-4 w-4 text-cyan-100" />
                    生成文案
                  </div>
                  <div className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-sm leading-7 text-slate-300">
                    {selectedVersion.optimizedScript || selectedVersion.originalScript}
                  </div>
                </div>
                <div className="projects-content-card projects-version-dock min-w-0 rounded-2xl p-4">
                  <div className="mb-3 flex items-center justify-between gap-3 text-sm font-bold text-white">
                    <div className="flex items-center gap-2">
                      <CalendarClock className="h-4 w-4 text-cyan-100" />
                      分段列表
                    </div>
                    <span className="text-xs font-semibold text-slate-500">共 {project.versions.length} 段</span>
                  </div>
                  <div className="projects-version-list" aria-label="项目分段列表">
                    {project.versions.map((version) => (
                      <button
                        key={version.id}
                        type="button"
                        onClick={() => setSelectedVersionId(version.id)}
                        className={`projects-version-button ${
                          version.id === selectedVersion.id ? "projects-version-button-active" : ""
                        }`}
                      >
                        <span>第 {version.versionNumber} 段</span>
                        <span>{formatDate(version.createdAt)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {selectedVersion.fullVideoPrompt && (
                <div className="projects-content-card min-w-0 rounded-2xl p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-bold text-white">
                    <FileText className="h-4 w-4 text-cyan-100" />
                    视频生成提示词
                  </div>
                  <div className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words text-sm leading-7 text-slate-300">
                    {selectedVersion.fullVideoPrompt}
                  </div>
                </div>
              )}

              {SHOW_DIRECTOR_MEMORY && (
                <div className="rounded-2xl border border-cyan-300/12 bg-black/20 p-4">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-cyan-200/70">Director Memory</div>
                      <h3 className="mt-1 text-lg font-black text-white">导演记忆</h3>
                    </div>
                    <button
                      type="button"
                      onClick={editStoryBible}
                      className="rounded-xl border border-cyan-300/18 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-300/16"
                    >
                      编辑项目圣经
                    </button>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <div className="rounded-xl border border-white/10 bg-slate-950/55 p-3">
                      <div className="mb-2 text-sm font-bold text-white">storyBible / 项目圣经</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-400">
                        {formatJson(project.storyBible || {})}
                      </pre>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-slate-950/55 p-3">
                      <div className="mb-2 text-sm font-bold text-white">qualityCheck / 质量自检</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-400">
                        {formatJson(selectedVersion.qualityCheck || {})}
                      </pre>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 xl:grid-cols-3">
                    <div className="rounded-xl border border-white/10 bg-slate-950/55 p-3">
                      <div className="mb-3 text-sm font-bold text-white">characterProfiles / 角色档案</div>
                      <div className="space-y-2">
                        {(project.characterProfiles || []).map((character) => (
                          <div key={character.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-semibold text-white">{character.name}</div>
                                <div className="mt-1 text-xs text-slate-500">{character.role || "角色"} · {character.locked ? "已锁定" : "未锁定"}</div>
                              </div>
                              <button
                                type="button"
                                onClick={() => editCharacter(character)}
                                className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-200 hover:bg-white/[0.08]"
                              >
                                编辑
                              </button>
                            </div>
                            <p className="mt-2 text-xs leading-5 text-slate-400">
                              {character.visualLock || character.appearance || character.personality || "-"}
                            </p>
                          </div>
                        ))}
                        {!(project.characterProfiles || []).length && <div className="text-xs text-slate-500">暂无角色记忆</div>}
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-slate-950/55 p-3">
                      <div className="mb-3 text-sm font-bold text-white">storyLoops / 伏笔列表</div>
                      <div className="space-y-2">
                        {(project.storyLoops || []).map((loop) => (
                          <div key={loop.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-semibold text-white">{loop.title}</div>
                                <div className="mt-1 text-xs text-slate-500">{loop.status} · {loop.importance.toFixed(2)}</div>
                              </div>
                              {loop.status !== "RESOLVED" && (
                                <button
                                  type="button"
                                  onClick={() => resolveStoryLoop(loop)}
                                  className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-200 hover:bg-white/[0.08]"
                                >
                                  标记解决
                                </button>
                              )}
                            </div>
                            <p className="mt-2 text-xs leading-5 text-slate-400">{loop.description || "-"}</p>
                          </div>
                        ))}
                        {!(project.storyLoops || []).length && <div className="text-xs text-slate-500">暂无伏笔记忆</div>}
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-slate-950/55 p-3">
                      <div className="mb-1 text-sm font-bold text-white">Retrieval Debug / 检索记忆库</div>
                      <p className="mb-3 text-xs leading-5 text-slate-500">
                        score = importance * 0.5 + relevance * 0.4 + recency * 0.1
                      </p>
                      <div className="max-h-96 space-y-2 overflow-auto pr-1">
                        {(project.memoryItems || []).map((memory) => (
                          <div
                            key={memory.id}
                            className={`rounded-lg border p-3 ${
                              memory.isEnabled === false
                                ? "border-white/5 bg-white/[0.015] opacity-55"
                                : "border-white/10 bg-white/[0.03]"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-semibold text-white">{memory.title || memory.type}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {memory.type} · I {memory.importance.toFixed(2)} · R {memory.recency.toFixed(2)} ·{" "}
                                  {memory.isEnabled === false ? "disabled" : "enabled"} · {memory.source || "local"}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => toggleMemory(memory)}
                                className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-200 hover:bg-white/[0.08]"
                              >
                                {memory.isEnabled === false ? "启用" : "停用"}
                              </button>
                            </div>
                            {Array.isArray(memory.keywords) && memory.keywords.length ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {memory.keywords.slice(0, 8).map((keyword, index) => (
                                  <span
                                    key={`${String(keyword)}-${index}`}
                                    className="rounded-full border border-cyan-200/15 px-2 py-0.5 text-[11px] text-cyan-100/70"
                                  >
                                    {String(keyword)}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <p className="mt-2 text-xs leading-5 text-slate-400">{memory.content}</p>
                          </div>
                        ))}
                        {!(project.memoryItems || []).length && <div className="text-xs text-slate-500">暂无检索记忆</div>}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="max-w-full overflow-x-auto rounded-2xl border border-slate-300/14 bg-slate-950/35">
                <table className="w-full min-w-[1680px] border-collapse text-left text-sm">
                  <thead className="bg-cyan-300/[0.06] text-xs uppercase text-cyan-100/70">
                    <tr>
                      <th className="p-3">镜头</th>
                      <th className="p-3">画面</th>
                      <th className="p-3">镜头分镜图</th>
                      <th className="p-3">景别</th>
                      <th className="p-3">机位/构图</th>
                      <th className="p-3">运镜</th>
                      <th className="p-3">光影/色调</th>
                      <th className="p-3">声音/台词</th>
                      <th className="p-3">情绪</th>
                      <th className="p-3">转场</th>
                      <th className="p-3">镜头目的</th>
                      <th className="p-3">视频提示词</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedVersion.shots.map((shot) => {
                      const storyboardAssets = getShotAssets(selectedVersion, shot, "SHOT_STORYBOARD");
                      const isShotGenerating = storyboardGeneratingShotSet.has(shot.shotNumber);
                      return (
                          <tr key={shot.id} className="border-t border-cyan-300/10 align-top text-slate-300">
                            <td className="p-3 font-bold text-cyan-100">{shot.shotNumber}</td>
                            <td className="max-w-[280px] p-3">{shot.visual || shot.scene || "-"}</td>
                            <td className="w-48 p-3">
                              {storyboardAssets[0]?.imageUrl ? (
                                <div className="w-44 space-y-2">
                                  <a
                                    href={storyboardAssets[0].imageUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block overflow-hidden rounded-xl border border-cyan-300/16 bg-slate-950 transition hover:border-cyan-200/45"
                                  >
                                    <img
                                      src={storyboardAssets[0].imageUrl}
                                      alt={`镜头 ${shot.shotNumber} 分镜图`}
                                      className="aspect-video w-full object-cover"
                                    />
                                  </a>
                                  <button
                                    type="button"
                                    onClick={() => regenerateShotStoryboard(shot)}
                                    disabled={isStoryboardGenerating}
                                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-cyan-300/18 bg-cyan-300/[0.08] px-2 py-1.5 text-xs font-semibold text-cyan-50 transition hover:bg-cyan-300/[0.14] disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {isShotGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    {isShotGenerating ? "生成中" : "重新生成"}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => regenerateShotStoryboard(shot)}
                                  disabled={isStoryboardGenerating}
                                  className="inline-flex w-44 items-center justify-center gap-2 rounded-xl border border-dashed border-cyan-300/18 bg-slate-950/60 px-3 py-7 text-center text-xs font-semibold text-slate-400 transition hover:border-cyan-200/35 hover:text-cyan-50 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {isShotGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                                  {isShotGenerating ? "生成中" : "生成本镜头"}
                                </button>
                              )}
                            </td>
                            <td className="p-3 text-slate-400">{shot.shotType || "-"}</td>
                            <td className="p-3 text-slate-400">{shot.composition || "-"}</td>
                            <td className="p-3 text-slate-400">{shot.cameraMovement || "-"}</td>
                            <td className="p-3 text-slate-400">{shot.lighting || "-"}</td>
                            <td className="max-w-[260px] p-3 text-slate-400">
                              <div>{shot.sound || "-"}</div>
                              <div className="mt-2 text-slate-500">台词：{shot.dialogue || "-"}</div>
                            </td>
                            <td className="p-3 text-slate-400">{shot.emotion || "-"}</td>
                            <td className="p-3 text-slate-400">{shot.transition || "-"}</td>
                            <td className="max-w-[260px] p-3 text-slate-400">{shot.shotPurpose || "-"}</td>
                            <td className="max-w-[360px] p-3 text-slate-400">{shot.videoPrompt || "-"}</td>
                          </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
                </>
              )}

              {projectDetailView === "assets" && (
                <section className="projects-asset-library rounded-2xl border border-cyan-300/14 bg-slate-950/32 p-4">
                  <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-cyan-200/70">Project Visual Bible</div>
                      <h3 className="mt-1 text-lg font-black text-white">项目视觉圣经</h3>
                      <p className="mt-2 text-sm text-slate-500">
                        这里集中存放本项目固定的角色三视图、场景图、道具图和风格参考。
                      </p>
                    </div>
                    <div className="rounded-full border border-cyan-200/15 bg-cyan-300/[0.08] px-3 py-1 text-xs font-semibold text-cyan-50">
                      共 {projectAssetLibrarySections.reduce((count, section) => count + section.entities.length, 0)} 个资产对象
                    </div>
                  </div>

                  {(visualAssetGenerationMessage || visualAssetGenerationError) && (
                    <div
                      className={`mb-5 rounded-2xl border px-4 py-3 text-sm ${
                        visualAssetGenerationError
                          ? "border-red-400/25 bg-red-500/10 text-red-100"
                          : "border-cyan-300/16 bg-cyan-300/[0.07] text-cyan-50"
                      }`}
                    >
                      {visualAssetGenerationError || visualAssetGenerationMessage}
                    </div>
                  )}

                  <div className="projects-asset-tabs mb-5 flex flex-wrap gap-2" role="tablist" aria-label="资产库分类">
                    {projectAssetLibrarySections.map((section) => {
                      const Icon = section.icon;
                      const active = section.type === activeAssetType;
                      return (
                        <button
                          key={section.type}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setActiveAssetType(section.type)}
                          className={`projects-asset-tab ${active ? "projects-asset-tab-active" : ""}`}
                        >
                          <Icon className="h-4 w-4" />
                          <span>{section.label}</span>
                          <span className="projects-asset-count">{section.entities.length}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="projects-asset-grid">
                    {activeAssetLibrarySection.entities.map((entity) => {
                      const entityAssets = getEntityVisualAssets(project, entity);
                      const primaryAsset = getPrimaryEntityAsset(project, entity);
                      const isVisualAssetGenerating = visualAssetGeneratingEntityId === entity.id;

                      return (
                        <article key={entity.id} className="projects-asset-card">
                          <div className="projects-asset-preview">
                            {primaryAsset?.imageUrl ? (
                              <img
                                src={primaryAsset.imageUrl}
                                alt={`${entity.name} ${activeAssetLibrarySection.assetLabel}`}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-500">
                                <ImageIcon className="h-5 w-5 text-cyan-100/50" />
                                <span>{activeAssetLibrarySection.assetLabel}待生成</span>
                              </div>
                            )}
                          </div>
                          <div className="p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <h4 className="truncate text-sm font-bold text-white">{entity.name}</h4>
                                <div className="mt-1 text-xs text-slate-500">
                                  @{entity.key} · {entityAssets.length} 个{activeAssetLibrarySection.assetLabel}
                                </div>
                              </div>
                              <span className="shrink-0 rounded-full border border-cyan-200/15 bg-cyan-300/[0.08] px-2 py-0.5 text-[11px] font-semibold text-cyan-50">
                                {getVisualEntityStatusLabel(entity.status)}
                              </span>
                            </div>
                            <p className="mt-3 line-clamp-3 text-xs leading-5 text-slate-400">
                              {entity.visualLock || entity.canonicalPrompt || entity.negativeLock || "等待生成或确认视觉锁定。"}
                            </p>
                            <button
                              type="button"
                              onClick={() => generateProjectVisualEntityAsset(entity)}
                              disabled={Boolean(visualAssetGeneratingEntityId)}
                              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-300/18 bg-cyan-300/[0.08] px-3 py-2 text-xs font-semibold text-cyan-50 transition hover:bg-cyan-300/[0.14] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isVisualAssetGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
                              {isVisualAssetGenerating ? "生成中" : primaryAsset?.imageUrl ? "重新生成" : "生成资产图"}
                            </button>
                          </div>
                        </article>
                      );
                    })}

                    {!activeAssetLibrarySection.entities.length && (
                      <div className="projects-asset-empty">
                        <ImageIcon className="h-5 w-5 text-cyan-100/45" />
                        <span>{activeAssetLibrarySection.empty}</span>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
