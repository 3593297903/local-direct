import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoryboardCodexPanelStatus = "pending" | "running" | "completed" | "failed";
export type StoryboardCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type StoryboardCodexShotInput = {
  shotNumber: number;
  scene?: string;
  visual?: string;
  shotType?: string;
  composition?: string;
  cameraMovement?: string;
  lighting?: string;
  sound?: string;
  dialogue?: string;
  emotion?: string;
  transition?: string;
  shotPurpose?: string;
  videoPrompt?: string;
  negativePrompt?: string;
};

export type CreateStoryboardCodexJobInput = {
  projectId: string;
  versionId: string;
  title: string;
  style: string;
  storyboard: StoryboardCodexShotInput[];
  size?: string;
  quality?: string;
};

export type StoryboardCodexPanelTask = {
  id: string;
  jobId: string;
  projectId: string;
  versionId: string;
  shotNumber: number;
  batchIndex: number;
  batchTotal: number;
  prompt: string;
  size: string;
  quality: string;
  status: StoryboardCodexPanelStatus;
  outputFileName: string;
  outputPath: string;
  imageUrl: string | null;
  error: string | null;
  attempts?: number;
  sourceImagePath?: string | null;
  outputHash?: string | null;
  imageFingerprint?: string | null;
  codexLogPath?: string | null;
  duplicateOfPanelId?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type StoryboardCodexJob = {
  id: string;
  projectId: string;
  versionId: string;
  title: string;
  style: string;
  prompt: string;
  status: StoryboardCodexJobStatus;
  panels: StoryboardCodexPanelTask[];
  sheetFileName: string;
  sheetPath: string;
  sheetUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type QueueOptions = {
  rootDir?: string;
};

type ClaimOptions = QueueOptions & {
  order?: "oldest" | "newest";
  runningTimeoutMs?: number;
};

type CompletePanelOptions = QueueOptions & {
  sourceImagePath?: string | null;
  imageFingerprint?: string | null;
  codexLogPath?: string | null;
};

type PanelOutputInfo = {
  outputHash: string;
  sourceImagePath: string | null;
  imageFingerprint: string | null;
  codexLogPath: string | null;
};

type DuplicatePanelMatch = {
  panel: StoryboardCodexPanelTask;
  reason: "source" | "hash" | "fingerprint";
};

const TASK_ROOT = ".tmp-storyboard-codex";
const JOB_DIR = "jobs";
const QUEUE_LOCK_DIR = "queue.lock";
const QUEUE_LOCK_TIMEOUT_MS = 10_000;
const QUEUE_LOCK_STALE_MS = 60_000;
const PANEL_MAX_ATTEMPTS = 3;
const STORYBOARD_ASSET_DIR = ["public", "project-assets", "storyboards"];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class StoryboardCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardCodexQueueError";
  }
}

export async function createStoryboardCodexJob(
  input: CreateStoryboardCodexJobInput,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    validateCreateInput(input);

    const now = new Date().toISOString();
    const jobId = createId("storyboard-job");
    const safeProjectId = fileSegment(input.projectId);
    const safeVersionId = fileSegment(input.versionId);
    const sheetFileName = `sheet-${jobId}.svg`;
    const outputDir = storyboardOutputDir(rootDir, safeProjectId, safeVersionId);
    const sheetPath = path.join(outputDir, sheetFileName);
    const batchTotal = input.storyboard.length;
    const size = input.size || "1024x576";
    const quality = input.quality || "medium";

    const panels = input.storyboard.map((shot, index) => {
      const panelId = createId(`panel-${shot.shotNumber}`);
      const outputFileName = `shot-${shot.shotNumber}-${panelId}.png`;
      return {
        id: panelId,
        jobId,
        projectId: input.projectId,
        versionId: input.versionId,
        shotNumber: Number(shot.shotNumber),
        batchIndex: index + 1,
        batchTotal,
        prompt: buildStoryboardPanelPrompt(input, shot, index + 1, batchTotal),
        size,
        quality,
        status: "pending" as const,
        outputFileName,
        outputPath: path.join(outputDir, outputFileName),
        imageUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      } satisfies StoryboardCodexPanelTask;
    });

    const job: StoryboardCodexJob = {
      status: "pending" as const,
      id: jobId,
      projectId: input.projectId,
      versionId: input.versionId,
      title: input.title,
      style: input.style,
      prompt: buildStoryboardSheetPrompt(input),
      panels,
      sheetFileName,
      sheetPath,
      sheetUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    await ensureQueueDirs(rootDir);
    await mkdir(outputDir, { recursive: true });
    await writeJob(rootDir, job);
    return job;
  });
}

export async function getStoryboardCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const job = await readJob(rootDir, jobId);
    return syncAndSaveJob(rootDir, job);
  });
}

export async function claimNextStoryboardCodexPanel(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const jobs = await listJobs(rootDir);
    const syncedJobs = await Promise.all(jobs.map((job) => syncAndSaveJob(rootDir, job)));
    const recoverableJobs = syncedJobs.map((job) => recoverStaleRunningPanels(job, options.runningTimeoutMs));
    await Promise.all(
      recoverableJobs.map((job, index) =>
        job === syncedJobs[index] ? Promise.resolve() : writeJob(rootDir, applyJobStatus(job)),
      ),
    );
    const direction = options.order === "newest" ? -1 : 1;
    const candidates = recoverableJobs
      .flatMap((job) => job.panels.map((panel) => ({ job, panel })))
      .filter(({ panel }) => panel.status === "pending")
      .sort((left, right) => direction * (Date.parse(left.panel.createdAt) - Date.parse(right.panel.createdAt)));

    const next = candidates[0];
    if (!next) return null;

    const now = new Date().toISOString();
    const panels = next.job.panels.map((panel) =>
      panel.id === next.panel.id
        ? {
            ...panel,
            status: "running" as const,
            attempts: (panel.attempts || 0) + 1,
            startedAt: now,
            updatedAt: now,
            error: null,
          }
        : panel,
    );
    const job = applyJobStatus({ ...next.job, panels, status: "running", updatedAt: now });
    await writeJob(rootDir, job);
    return job.panels.find((panel) => panel.id === next.panel.id) || null;
  });
}

function recoverStaleRunningPanels(job: StoryboardCodexJob, runningTimeoutMs: number | undefined) {
  if (!runningTimeoutMs || runningTimeoutMs <= 0) return job;

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  let changed = false;
  const panels = job.panels.map((panel) => {
    if (panel.status !== "running") return panel;

    const startedAtMs = Date.parse(panel.startedAt || panel.updatedAt || panel.createdAt);
    if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs < runningTimeoutMs) return panel;

    changed = true;
    return {
      ...panel,
      status: "pending" as const,
      startedAt: undefined,
      error: "Previous Codex run exceeded the storyboard task timeout and was returned to the queue",
      updatedAt: now,
    };
  });

  return changed ? { ...job, panels, updatedAt: now } : job;
}

export async function completeStoryboardCodexPanel(
  jobId: string,
  panelId: string,
  options: CompletePanelOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const job = await readJob(rootDir, jobId);
    const panel = job.panels.find((item) => item.id === panelId);
    if (!panel) throw new StoryboardCodexQueueError("Storyboard panel task not found");

    await assertOutputFile(panel.outputPath, panel.size);
    const outputInfo = await readPanelOutputInfo(panel, options);
    const duplicate = findDuplicateCompletedPanel(job.panels, panel.id, outputInfo);
    const now = new Date().toISOString();

    let outputShouldBeRemoved = false;
    const panels = job.panels.map((item) => {
      if (item.id !== panelId) return item;
      if (duplicate) {
        outputShouldBeRemoved = true;
        return duplicatePanelUpdate(item, duplicate, outputInfo, now);
      }

      return {
        ...item,
        status: "completed" as const,
        imageUrl: panelImageUrl(job.projectId, job.versionId, item.outputFileName),
        error: null,
        sourceImagePath: outputInfo.sourceImagePath,
        outputHash: outputInfo.outputHash,
        imageFingerprint: outputInfo.imageFingerprint,
        codexLogPath: outputInfo.codexLogPath,
        duplicateOfPanelId: null,
        completedAt: now,
        updatedAt: now,
      };
    });

    if (outputShouldBeRemoved) {
      await rm(panel.outputPath, { force: true });
    }

    const updated = await finalizeIfReady(rootDir, applyJobStatus({ ...job, panels, updatedAt: now }));
    await writeJob(rootDir, updated);
    return updated;
  });
}

export async function failStoryboardCodexPanel(
  jobId: string,
  panelId: string,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const job = await readJob(rootDir, jobId);
    const now = new Date().toISOString();
    const panels = job.panels.map((panel) => {
      if (panel.id !== panelId) return panel;

      const attempts = panel.attempts || 0;
      const retryable = attempts < PANEL_MAX_ATTEMPTS;
      const baseMessage = message || "Codex storyboard panel generation failed";

      return {
        ...panel,
        status: retryable ? ("pending" as const) : ("failed" as const),
        imageUrl: null,
        error: retryable
          ? `${baseMessage}; queued for retry (${attempts}/${PANEL_MAX_ATTEMPTS})`
          : `${baseMessage}; maximum retry attempts reached`,
        startedAt: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
    });
    const updated = applyJobStatus({ ...job, panels, updatedAt: now });
    await writeJob(rootDir, updated);
    return updated;
  });
}

export async function failStoryboardCodexJob(
  jobId: string,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const job = await readJob(rootDir, jobId);
    const now = new Date().toISOString();
    const baseMessage = message || "Codex storyboard generation failed";
    const panels = job.panels.map((panel) => {
      if (panel.status === "completed") return panel;
      return {
        ...panel,
        status: "failed" as const,
        imageUrl: null,
        error: baseMessage,
        startedAt: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
    });
    const updated = applyJobStatus({
      ...job,
      panels,
      status: "failed",
      error: baseMessage,
      updatedAt: now,
    });
    await writeJob(rootDir, updated);
    return updated;
  });
}

function buildStoryboardPanelPrompt(
  input: CreateStoryboardCodexJobInput,
  shot: StoryboardCodexShotInput,
  batchIndex: number,
  batchTotal: number,
) {
  return [
    "Create ONE single cinematic production storyboard frame for this Local Director shot.",
    "",
    "This request must produce exactly one 16:9 full color movie storyboard frame, not a multi-panel sheet.",
    "Use case: cinematic-production-storyboard",
    "Asset type: shot storyboard visual asset",
    `Project title: ${input.title}`,
    `Overall style: ${input.style}`,
    `Batch: shot ${batchIndex}/${batchTotal}`,
    "",
    `Shot number: ${shot.shotNumber}`,
    `Scene/backdrop: ${shot.scene || "current scene from the script"}`,
    `Subject/action: ${shot.visual || shot.videoPrompt || "the key story action in this shot"}`,
    `Camera position/composition: ${shot.composition || "cinematic 16:9 composition with clear subject placement"}`,
    `Shot size and camera: ${shot.shotType || "cinematic shot"} / ${shot.cameraMovement || "camera movement implied by framing"}`,
    `Lighting/color tone: ${shot.lighting || "cinematic film lighting based on the story mood"}`,
    `Sound/dialogue context: ${shot.sound || "natural scene ambience"} / ${shot.dialogue || "no dialogue"}`,
    `Mood: ${shot.emotion || "cinematic tension"}`,
    `Transition intent: ${shot.transition || "natural cut"}`,
    `Shot purpose: ${shot.shotPurpose || "advance the story and preserve visual continuity"}`,
    `Video prompt reference: ${shot.videoPrompt || ""}`,
    "",
    "Generate the image based directly on the shot video prompt, using the scene, action, shot size, camera movement, mood, and transition notes only as production guidance.",
    "Style/medium: full color cinematic film storyboard frame, realistic people and environments, polished movie lighting, production concept art quality.",
    "Composition/framing: horizontal 16:9 frame, clear foreground/midground/background, full-frame single shot illustration.",
    "Lighting/mood: dramatic but readable film lighting, consistent character identity, clothing, props, setting direction, and tone across the batch.",
    "Text: no labels, no captions, no subtitles, no shot numbers, no watermark, no UI, no body text inside the image.",
    `Avoid: ${shot.negativePrompt || "no watermark, no UI, no website screenshot, no extra panels, no duplicated shots"}`,
  ].join("\n");
}

function buildStoryboardSheetPrompt(input: CreateStoryboardCodexJobInput) {
  return [
    `Local Director storyboard sheet for ${input.title}.`,
    `Style: ${input.style}.`,
    `Panels: ${input.storyboard.length}.`,
  ].join("\n");
}

async function syncAndSaveJob(rootDir: string, job: StoryboardCodexJob) {
  const synced = await syncJobFromOutputFiles(rootDir, job);
  const finalized = await finalizeIfReady(rootDir, applyJobStatus(synced));
  if (JSON.stringify(finalized) !== JSON.stringify(job)) {
    await writeJob(rootDir, finalized);
  }
  return finalized;
}

async function syncJobFromOutputFiles(_rootDir: string, job: StoryboardCodexJob) {
  let changed = false;
  const panels: StoryboardCodexPanelTask[] = [];
  for (const panel of job.panels) {
    if (panel.status === "completed") {
      panels.push(panel);
      continue;
    }

    if (await isValidOutputFile(panel.outputPath, panel.size)) {
      changed = true;
      const now = new Date().toISOString();
      const outputInfo = await readPanelOutputInfo(panel, {});
      const duplicate = findDuplicateCompletedPanel(panels, panel.id, outputInfo);
      if (duplicate) {
        await rm(panel.outputPath, { force: true });
        panels.push(duplicatePanelUpdate(panel, duplicate, outputInfo, now));
      } else {
        panels.push({
          ...panel,
          status: "completed",
          imageUrl: panelImageUrl(job.projectId, job.versionId, panel.outputFileName),
          error: null,
          sourceImagePath: outputInfo.sourceImagePath,
          outputHash: outputInfo.outputHash,
          imageFingerprint: outputInfo.imageFingerprint,
          codexLogPath: outputInfo.codexLogPath,
          duplicateOfPanelId: null,
          completedAt: panel.completedAt || now,
          updatedAt: now,
        });
      }
      continue;
    }

    panels.push(panel);
  }

  return changed ? { ...job, panels, updatedAt: new Date().toISOString() } : job;
}

async function finalizeIfReady(rootDir: string, job: StoryboardCodexJob) {
  if (!job.panels.length || !job.panels.every((panel) => panel.status === "completed" && panel.imageUrl)) {
    return job;
  }

  return {
    ...job,
    status: "completed" as const,
    sheetUrl: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

function applyJobStatus(job: StoryboardCodexJob): StoryboardCodexJob {
  if (job.panels.every((panel) => panel.status === "completed")) {
    return { ...job, status: "completed", error: null };
  }
  if (job.panels.some((panel) => panel.status === "running")) {
    return { ...job, status: "running", error: null };
  }
  if (job.panels.every((panel) => panel.status === "failed")) {
    return { ...job, status: "failed", error: "All storyboard panel tasks failed" };
  }
  if (job.panels.some((panel) => panel.status === "failed") && !job.panels.some((panel) => panel.status === "pending")) {
    return { ...job, status: "failed", error: "One or more storyboard panel tasks failed" };
  }
  return { ...job, status: "pending", error: null };
}

async function readPanelOutputInfo(
  panel: StoryboardCodexPanelTask,
  options: CompletePanelOptions,
): Promise<PanelOutputInfo> {
  const buffer = await readFile(panel.outputPath);
  return {
    outputHash: createHash("sha256").update(buffer).digest("hex"),
    sourceImagePath: cleanOptionalString(options.sourceImagePath ?? panel.sourceImagePath),
    imageFingerprint: normalizeFingerprint(options.imageFingerprint ?? panel.imageFingerprint),
    codexLogPath: cleanOptionalString(options.codexLogPath ?? panel.codexLogPath),
  };
}

function findDuplicateCompletedPanel(
  panels: StoryboardCodexPanelTask[],
  currentPanelId: string,
  outputInfo: PanelOutputInfo,
): DuplicatePanelMatch | null {
  const currentSourcePath = normalizeSourcePath(outputInfo.sourceImagePath);

  for (const panel of panels) {
    if (panel.id === currentPanelId || panel.status !== "completed") continue;

    if (currentSourcePath && normalizeSourcePath(panel.sourceImagePath) === currentSourcePath) {
      return { panel, reason: "source" };
    }

    if (outputInfo.outputHash && panel.outputHash && outputInfo.outputHash === panel.outputHash) {
      return { panel, reason: "hash" };
    }

    if (areFingerprintsNearDuplicate(outputInfo.imageFingerprint, panel.imageFingerprint)) {
      return { panel, reason: "fingerprint" };
    }
  }

  return null;
}

function duplicatePanelUpdate(
  panel: StoryboardCodexPanelTask,
  duplicate: DuplicatePanelMatch,
  outputInfo: PanelOutputInfo,
  now: string,
): StoryboardCodexPanelTask {
  const attempts = panel.attempts || 0;
  const duplicateLabel = `shot ${duplicate.panel.shotNumber}`;
  const retryable = attempts < PANEL_MAX_ATTEMPTS;
  const message = retryable
    ? `Duplicate storyboard image detected by ${duplicate.reason} against ${duplicateLabel}; queued for retry`
    : `Duplicate storyboard image detected by ${duplicate.reason} against ${duplicateLabel}; maximum retry attempts reached`;

  return {
    ...panel,
    status: retryable ? "pending" : "failed",
    imageUrl: null,
    error: message,
    sourceImagePath: outputInfo.sourceImagePath,
    outputHash: outputInfo.outputHash,
    imageFingerprint: outputInfo.imageFingerprint,
    codexLogPath: outputInfo.codexLogPath,
    duplicateOfPanelId: duplicate.panel.id,
    startedAt: undefined,
    completedAt: undefined,
    updatedAt: now,
  };
}

function cleanOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeSourcePath(value: unknown) {
  const cleaned = cleanOptionalString(value);
  return cleaned ? cleaned.replace(/\//g, "\\").toLowerCase() : null;
}

function normalizeFingerprint(value: unknown) {
  const cleaned = cleanOptionalString(value);
  if (!cleaned) return null;
  const normalized = cleaned.replace(/[^a-f0-9]/gi, "").toLowerCase();
  return normalized.length >= 64 && normalized.length % 2 === 0 ? normalized : null;
}

function areFingerprintsNearDuplicate(left: unknown, right: unknown) {
  const leftBytes = fingerprintBytes(normalizeFingerprint(left));
  const rightBytes = fingerprintBytes(normalizeFingerprint(right));
  if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) return false;

  let totalDiff = 0;
  let nearPixels = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    const diff = Math.abs(leftBytes[index] - rightBytes[index]);
    totalDiff += diff;
    if (diff <= 4) nearPixels += 1;
  }

  const meanDiff = totalDiff / leftBytes.length;
  const nearRatio = nearPixels / leftBytes.length;
  return meanDiff <= 2 && nearRatio >= 0.98;
}

function fingerprintBytes(fingerprint: string | null) {
  if (!fingerprint) return null;
  const bytes: number[] = [];
  for (let index = 0; index < fingerprint.length; index += 2) {
    bytes.push(Number.parseInt(fingerprint.slice(index, index + 2), 16));
  }
  return bytes.every((byte) => Number.isFinite(byte)) ? bytes : null;
}

async function buildSheetSvg(job: StoryboardCodexJob) {
  const width = 1024;
  const panelHeight = 576;
  const divider = 16;
  const height = job.panels.length * panelHeight + Math.max(0, job.panels.length - 1) * divider;
  const panelMarkup = await Promise.all(
    job.panels.map(async (panel, index) => {
      const y = index * (panelHeight + divider);
      const href = svgEscape(await panelDataUri(panel));
      return `
        <g transform="translate(0 ${y})">
          <rect x="0" y="0" width="${width}" height="${panelHeight}" fill="#050816"/>
          <image href="${href}" x="0" y="0" width="${width}" height="${panelHeight}" preserveAspectRatio="xMidYMid slice"/>
          <rect x="0" y="0" width="${width}" height="${panelHeight}" fill="none" stroke="#050505" stroke-width="8"/>
          <rect x="18" y="16" width="132" height="48" fill="#f3f0e8" stroke="#111" stroke-width="3"/>
          <text x="34" y="49" fill="#111" font-size="28" font-weight="700">镜头${panel.shotNumber}</text>
        </g>`;
    }),
  );
  const panels = panelMarkup.join("");
  const dividers = job.panels
    .slice(1)
    .map((_, index) => {
      const y = (index + 1) * panelHeight + index * divider;
      return `<rect x="0" y="${y}" width="${width}" height="${divider}" fill="#050505"/>`;
    })
    .join("");

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#050505"/>
      ${panels}
      ${dividers}
    </svg>`;
}

async function panelDataUri(panel: StoryboardCodexPanelTask) {
  const buffer = await readFile(panel.outputPath);
  return `data:${panelMimeType(panel.outputFileName)};base64,${buffer.toString("base64")}`;
}

function panelMimeType(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "image/png";
}

async function listJobs(rootDir: string) {
  await ensureQueueDirs(rootDir);
  const dir = jobDir(rootDir);
  const entries = await readdir(dir, { withFileTypes: true });
  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJob(rootDir, entry.name.replace(/\.json$/, ""))),
  );
  return jobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

async function readJob(rootDir: string, jobId: string): Promise<StoryboardCodexJob> {
  try {
    return JSON.parse(await readFile(jobPath(rootDir, jobId), "utf8")) as StoryboardCodexJob;
  } catch (error) {
    throw new StoryboardCodexQueueError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "Storyboard image job not found" : "Storyboard image job could not be read",
    );
  }
}

async function writeJob(rootDir: string, job: StoryboardCodexJob) {
  await ensureQueueDirs(rootDir);
  await writeFile(jobPath(rootDir, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function ensureQueueDirs(rootDir: string) {
  await mkdir(jobDir(rootDir), { recursive: true });
}

async function withQueueLock<T>(rootDir: string, action: () => Promise<T>) {
  await ensureQueueDirs(rootDir);
  const lockPath = queueLockPath(rootDir);
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleQueueLock(lockPath);
      if (Date.now() - startedAt > QUEUE_LOCK_TIMEOUT_MS) {
        throw new StoryboardCodexQueueError("Storyboard image queue is busy; please retry shortly");
      }
      await delay(50);
    }
  }

  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeStaleQueueLock(lockPath: string) {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > QUEUE_LOCK_STALE_MS) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertOutputFile(filePath: string, expectedSize: string) {
  if (!(await isValidOutputFile(filePath, expectedSize))) {
    throw new StoryboardCodexQueueError(`Codex did not produce a valid storyboard image: ${filePath}`);
  }
}

async function isValidOutputFile(filePath: string, expectedSize: string) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0) return false;

    const expectedDimensions = parseImageSize(expectedSize);
    const actualDimensions = await readPngDimensions(filePath);
    return (
      Boolean(actualDimensions) &&
      actualDimensions?.width === expectedDimensions.width &&
      actualDimensions?.height === expectedDimensions.height
    );
  } catch {
    return false;
  }
}

async function readPngDimensions(filePath: string) {
  const buffer = await readFile(filePath);
  if (buffer.length < 33) return null;
  if (!PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseImageSize(size: string | undefined) {
  const match = /^(\d+)x(\d+)$/i.exec(size || "1024x576");
  if (!match) return { width: 1024, height: 576 };
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function validateCreateInput(input: CreateStoryboardCodexJobInput) {
  if (!input.projectId || !input.versionId) {
    throw new StoryboardCodexQueueError("Project id and version id are required");
  }
  if (!input.storyboard?.length) {
    throw new StoryboardCodexQueueError("Storyboard must contain at least one shot");
  }
  if (input.storyboard.length > 8) {
    throw new StoryboardCodexQueueError("Storyboard Codex generation supports up to 8 shots per job");
  }
}

function resolveRootDir(options: QueueOptions) {
  return options.rootDir || process.cwd();
}

function jobDir(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, JOB_DIR);
}

function queueLockPath(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, QUEUE_LOCK_DIR);
}

function jobPath(rootDir: string, jobId: string) {
  return path.join(jobDir(rootDir), `${fileSegment(jobId)}.json`);
}

function storyboardOutputDir(rootDir: string, projectId: string, versionId: string) {
  return path.join(rootDir, ...STORYBOARD_ASSET_DIR, projectId, versionId);
}

function panelImageUrl(projectId: string, versionId: string, fileName: string) {
  return `/project-assets/storyboards/${fileSegment(projectId)}/${fileSegment(versionId)}/${fileSegment(fileName)}`;
}

function sheetUrl(projectId: string, versionId: string, fileName: string) {
  return `/project-assets/storyboards/${fileSegment(projectId)}/${fileSegment(versionId)}/${fileSegment(fileName)}`;
}

function createId(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function fileSegment(value: string) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}

function svgEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
