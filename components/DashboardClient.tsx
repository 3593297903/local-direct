"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { AnalysisResult, KnowledgeItem, StoryboardShot } from "@/types";
import { CopyButton } from "@/components/CopyButton";
import { Drawer } from "@/components/Drawer";
import { PreviewAnimation } from "@/components/PreviewAnimation";
import { splitLongScriptIntoPromptSegments, type PromptSegment } from "@/lib/long-script";
import { matchShotReferences, ShotReferenceMatches } from "@/lib/reference-matcher";
import { Clock, Download, FileText, Film, ImageIcon, Loader2, Maximize2, ScanLine, Send, SlidersHorizontal, X } from "lucide-react";

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

class CodexVideoPromptJobFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexVideoPromptJobFailedError";
  }
}

type BatchPromptSection = {
  segment: PromptSegment;
  result: AnalysisResult;
  promptText: string;
};

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
  const coreTheme = workflow?.coreTheme || `${result.title}：围绕原文案核心事件，保持人物关系、线索顺序和情绪推进，生成一段可直接执行的 AI 视频提示词。`;
  const technicalParams =
    workflow?.videoParameterLock ||
    [
      `总时长：${result.duration}`,
      "画幅：16:9",
      `风格：${result.style}`,
      `场景：${result.contentType}对应的主要空间，保持原文案地点、时间、天气和人物关系一致。`,
      "运镜原则：按线索推进顺序设计镜头，由空间建立到关键动作，再到人物反应和段尾转场。",
      "光影原则：根据题材控制主色调、明暗层次和真实光源，不使用突兀过曝或廉价特效。",
      "声音原则：以真实环境声、动作声和必要台词为主，不使用喧宾夺主的背景音乐。",
      "画面表达重点：用空间、动作、物件、人物反应和镜头节奏表达剧情，不依赖血腥、怪物、突脸惊吓或无关元素。",
    ].join("\n");

  const shotLines = result.storyboard
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
  const [durationSeconds, setDurationSeconds] = useState(15);
  const [durationPickerOpen, setDurationPickerOpen] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [generationProgress, setGenerationProgress] = useState("");
  const [error, setError] = useState("");
  const [imageError, setImageError] = useState("");
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
      setGenerationProgress("已选择历史项目，新输入文案后会生成下一集。");
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
      setGenerationProgress(resumeVersion ? "已载入当前剧集，可修改后重新生成这一集。" : "已载入历史文案，可继续编辑。");
      window.localStorage.removeItem("vd_new_episode");
      window.localStorage.removeItem("vd_resume_script");
      window.localStorage.removeItem("vd_resume_project_id");
      window.localStorage.removeItem("vd_resume_version_id");
    }
  }, []);

  function getActiveResumeVersionId() {
    return creatingNewEpisodeRef.current ? undefined : resumeVersionId || undefined;
  }

  async function requestAnalysis(inputScript: string, inputDurationSeconds: number) {
    return requestAnalysisWithContext(
      inputScript,
      inputDurationSeconds,
      resumeProjectId || undefined,
      getActiveResumeVersionId(),
    );
  }

  async function requestAnalysisWithContext(
    inputScript: string,
    inputDurationSeconds: number,
    projectId: string | undefined = resumeProjectId || undefined,
    versionId: string | undefined = resumeVersionId || undefined,
  ) {
    return requestAnalysisWithProviderFallback(inputScript, inputDurationSeconds, projectId, versionId);
  }

  async function createVideoPromptCodexJob(
    inputScript: string,
    inputDurationSeconds: number,
    projectId: string | undefined,
    versionId: string | undefined,
  ) {
    const res = await fetch("/api/video-prompt/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script: inputScript,
        duration: `${inputDurationSeconds}秒`,
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
    inputDurationSeconds: number,
    projectId: string | undefined,
    versionId: string | undefined,
  ) {
    try {
      const job = await createVideoPromptCodexJob(inputScript, inputDurationSeconds, projectId, versionId);
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
      return requestAnalysisViaProvider(inputScript, inputDurationSeconds, projectId, versionId);
    }
  }

  async function requestAnalysisViaProvider(
    inputScript: string,
    inputDurationSeconds: number,
    projectId: string | undefined,
    versionId: string | undefined,
  ) {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script: inputScript,
        duration: `${inputDurationSeconds}秒`,
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

  async function handlePromptFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setUploadingText(true);
    setError("");
    setResult(null);
    setProjectSave(null);
    setBatchResults([]);
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
      const count = splitLongScriptIntoPromptSegments(cleanText).length || 1;
      setGenerationProgress(`已导入 ${file.name}，约 ${cleanText.length} 字，预计拆成 ${count} 段 15s 内提示词。`);
    } catch (err: any) {
      setError(err?.message || "文案文件读取失败");
      setGenerationProgress("");
    } finally {
      setUploadingText(false);
    }
  }

  async function analyze() {
    setLoading(true);
    setError("");
    setImageError("");
    setStoryboardImage(null);
    setSelectedShot(null);
    setReferenceShot(null);
    setSelectedLibraryItem(null);
    setProjectSave(null);
    setDurationPickerOpen(false);
    setBatchResults([]);

    try {
      if (uploadedFileName) {
        const segments = splitLongScriptIntoPromptSegments(script);
        const completed: BatchPromptSection[] = [];
        let activeProjectId = resumeProjectId || "";
        setBatchGenerating(true);

        for (const segment of segments) {
          setGenerationProgress(`正在生成第 ${segment.index} / ${segments.length} 段...`);
          const segmentResult = await requestAnalysisWithContext(segment.text, 15, activeProjectId || undefined, undefined);
          const fullVideoPrompt = buildVideoGenerationPromptText(segmentResult);
          const save = await saveAnalysisProject(segment.text, segmentResult, fullVideoPrompt, activeProjectId || undefined, undefined);
          setProjectSave(save);
          if (save.projectId) {
            activeProjectId = save.projectId;
            setResumeProjectId(save.projectId);
          }
          completed.push({
            segment,
            result: segmentResult,
            promptText: fullVideoPrompt,
          });
          setBatchResults([...completed]);
          setResult(segmentResult);
        }

        setGenerationProgress(`已生成 ${completed.length} 段，每段视频提示词均控制在 15s 内。`);
        return;
      }

      setGenerationProgress("正在生成...");
      const singleResult = await requestAnalysis(script, durationSeconds);
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
        : err?.message || "分析失败";
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
      setImageError(err.message || "镜头分镜图生成失败");
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
                  {durationSeconds}s
                </button>
                {durationPickerOpen && (
                  <div className="duration-popover" role="dialog" aria-label="选择视频时长">
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <span className="text-sm font-semibold text-slate-300">视频时长</span>
                      <span className="text-sm font-bold text-slate-200">{durationSeconds}s</span>
                    </div>
                    <input
                      type="range"
                      min="4"
                      max="15"
                      step="1"
                      value={durationSeconds}
                      onChange={(e) => setDurationSeconds(Number(e.target.value))}
                      className="duration-slider"
                    />
                    <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                      <span>4s</span>
                      <span>15s</span>
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
              <CopyButton text={JSON.stringify(result, null, 2)} label="复制全部 JSON" />
            </div>
          </div>

          {imageError && <p className="mb-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{imageError}</p>}

          {Boolean(batchResults.length) && (
            <div className="mb-6 rounded-2xl border border-violet-300/16 bg-violet-500/8 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-white">批量提示词生成</h3>
                  <p className="mt-1 text-sm text-slate-400">已生成 {batchResults.length} 段，每段按 15s 以内的视频提示词模板输出。</p>
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
