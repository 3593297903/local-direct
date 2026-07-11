import { unlink } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { NEST_AUTH_TOKEN_COOKIE } from "@/lib/nest-auth-proxy";
import type { AnalysisResult, StoryboardShot } from "@/types";

type ProjectCreatePayload = Record<string, unknown> & {
  idempotencyKey: string | undefined;
  projectId: string | undefined;
  versionId: string | undefined;
  title: string | undefined;
  originalScript: string | undefined;
  optimizedScript: string | undefined;
  contentType: string | undefined;
  style: string | undefined;
  duration: string | undefined;
  status: string | undefined;
  storyboardImageUrl: string | undefined;
  storyboardImagePrompt: string | undefined;
  fullVideoPrompt: string | undefined;
  storyBible: Record<string, unknown> | undefined;
  contextSummary: string | undefined;
  episodeSummary: string | undefined;
  endingState: string | undefined;
  characterState: string | undefined;
  memoryJson: Record<string, unknown> | undefined;
  contextSnapshot: Record<string, unknown> | undefined;
  narrativeMemory: Record<string, unknown> | undefined;
  stateVector: Record<string, unknown> | undefined;
  openLoops: unknown[] | undefined;
  qualityCheck: Record<string, unknown> | undefined;
  directorContext: string | undefined;
  shots: unknown[] | undefined;
  result: AnalysisResult | undefined;
};

type NestResponseData = Record<string, unknown> & {
  projects: unknown[] | undefined;
  project: unknown | undefined;
  saved: boolean | undefined;
  projectId: string | undefined;
  versionId: string | undefined;
  versionNumber: number | undefined;
  storyboardImageUrl: string | undefined;
  visualEntities: unknown[] | undefined;
  visualReferences: unknown[] | undefined;
};

type NestResponse = Record<string, unknown> & {
  ok: boolean | undefined;
  data: NestResponseData | undefined;
  error: string | undefined;
  message: string | string[] | undefined;
};

const NARRATIVE_STATE_FIELDS = ["stateVector", "openLoops", "narrativeMemory", "qualityCheck"];

function getNestApiBaseUrl() {
  return (process.env.NEST_API_BASE_URL || "http://localhost:4000/api").replace(/\/+$/, "");
}

function formatUpstreamError(payload: NestResponse | null, fallback: string) {
  const message = payload ? payload.message || payload.error || fallback : fallback;
  return Array.isArray(message) ? message.join("; ") : message;
}

async function readJson(response: Response): Promise<NestResponse | null> {
  try {
    return (await response.json()) as NestResponse;
  } catch {
    return null;
  }
}

function getBearerToken(request: NextRequest) {
  const cookie = request.cookies.get(NEST_AUTH_TOKEN_COOKIE);
  return cookie ? cookie.value : undefined;
}

function responseMessageText(payload: NestResponse | null) {
  const message = payload?.message || payload?.error || "";
  return Array.isArray(message) ? message.join("; ") : String(message);
}

function shouldRetryWithoutNarrativeState(upstream: Response, payload: NestResponse | null) {
  if (upstream.status !== 400) return false;
  const message = responseMessageText(payload);
  return NARRATIVE_STATE_FIELDS.some((field) => message.includes(`property ${field} should not exist`));
}

function omitNarrativeStateFields(body: Record<string, unknown>) {
  const next = { ...body };
  for (const field of NARRATIVE_STATE_FIELDS) {
    delete next[field];
  }
  return next;
}

async function postProjectToNest(token: string, body: Record<string, unknown>) {
  const upstream = await fetch(`${getNestApiBaseUrl()}/projects`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await readJson(upstream);
  return { upstream, payload };
}

async function postProjectToNestWithCompatibility(token: string, body: Record<string, unknown>) {
  const first = await postProjectToNest(token, body);
  if (!shouldRetryWithoutNarrativeState(first.upstream, first.payload)) {
    return first;
  }

  return postProjectToNest(token, omitNarrativeStateFields(body));
}

function mapShotToNestProjectBody(shot: StoryboardShot) {
  return {
    shotNumber: Number(shot.shotNumber),
    scene: shot.scene,
    visual: shot.visual,
    shotType: shot.shotType,
    composition: shot.composition,
    cameraMovement: shot.cameraMovement,
    lighting: shot.lighting,
    sound: shot.sound,
    dialogue: shot.dialogue,
    emotion: shot.emotion,
    transition: shot.transition,
    shotPurpose: shot.shotPurpose,
    firstFramePrompt: shot.firstFramePrompt,
    videoPrompt: shot.videoPrompt,
    lastFramePrompt: shot.lastFramePrompt,
    negativePrompt: shot.negativePrompt,
  };
}

function getNestResponseData(payload: NestResponse | null) {
  if (!payload || !payload.data || typeof payload.data !== "object") return null;
  return payload.data;
}

function cleanText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text === "undefined" || text === "null" || /\bundefined\b/i.test(text)) return undefined;
  return text ? text.slice(0, maxLength) : undefined;
}

function cleanLongText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text === "undefined" || text === "null" || /\bundefined\b/i.test(text)) return undefined;
  return text;
}

function deriveProjectSaveTitle(payload: ProjectCreatePayload) {
  const explicitTitle = cleanText(payload.result?.title, 80);
  if (explicitTitle) return explicitTitle;

  const sources = [
    payload.result?.optimizedScript,
    payload.result?.workflow?.fullVideoPrompt,
    payload.originalScript,
  ];
  for (const source of sources) {
    const text = cleanText(source, 300);
    if (!text) continue;

    const episodeMatch = text.match(/第\s*([0-9一二三四五六七八九十百]+)\s*[集段]\s*[｜|:：-]?\s*[《「“]?([^》」”\n:：，。,.]{2,40})/);
    if (episodeMatch?.[1] && episodeMatch[2]) {
      return `第${episodeMatch[1]}集｜${episodeMatch[2].trim()}`;
    }

    const bracketMatch = text.match(/《([^》]{2,40})》/);
    if (bracketMatch?.[1]) return bracketMatch[1].trim();

    const firstClause = text.split(/[。！？!?\n:：]/)[0]?.trim();
    if (firstClause) return firstClause.slice(0, 60);
  }

  return "未命名项目";
}

function deriveProjectSaveDuration(result: AnalysisResult | undefined) {
  const explicitDuration = cleanText(result?.duration, 40);
  if (explicitDuration) return explicitDuration;

  const shots = Array.isArray(result?.storyboard) ? result.storyboard : [];
  let maxSeconds = 0;
  for (const shot of shots) {
    if (typeof shot?.timeRange !== "string") continue;
    const matches = [...shot.timeRange.matchAll(/(\d+(?:\.\d+)?)\s*s/gi)];
    const last = matches.at(-1)?.[1];
    if (!last) continue;
    const seconds = Number(last);
    if (Number.isFinite(seconds)) maxSeconds = Math.max(maxSeconds, seconds);
  }

  if (maxSeconds > 0) {
    return `${Number.isInteger(maxSeconds) ? maxSeconds : Number(maxSeconds.toFixed(1))}秒`;
  }
  return "自动";
}

function deriveProjectSaveFullVideoPrompt(payload: ProjectCreatePayload) {
  return (
    cleanLongText(payload.fullVideoPrompt) ||
    cleanLongText(payload.result?.workflow?.fullVideoPrompt) ||
    cleanLongText(payload.result?.optimizedScript) ||
    ""
  );
}

function uniqueStrings(values: unknown[], limit = 12) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = cleanText(value, 100);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function getToneScore(values: string[], patterns: RegExp[]) {
  return values.some((value) => patterns.some((pattern) => pattern.test(value))) ? 0.75 : 0.25;
}

function deriveProjectMemoryFromAnalysis(originalScript: string | undefined, result: AnalysisResult) {
  const diagnosis = result.workflow?.generationDiagnosis;
  const shots = result.storyboard || [];
  const lastShot = shots.length ? shots[shots.length - 1] : undefined;
  const emotions = uniqueStrings([
    ...(diagnosis?.emotions || []),
    ...shots.map((shot) => shot.emotion),
  ]);
  const sceneKeywords = uniqueStrings([
    ...(diagnosis?.sceneKeywords || []),
    ...shots.map((shot) => shot.scene),
  ]);
  const visualFocus = uniqueStrings([
    ...(diagnosis?.visualFocus || []),
    ...shots.map((shot) => shot.visual),
  ]);
  const cameraMovements = uniqueStrings([
    diagnosis?.cameraStrategy,
    ...shots.map((shot) => shot.cameraMovement),
  ]);
  const transitions = uniqueStrings(shots.map((shot) => shot.transition));
  const avoid = uniqueStrings([
    ...(diagnosis?.avoid || []),
    ...shots.map((shot) => shot.negativePrompt),
  ]);
  const episodeSummary =
    cleanText(result.workflow?.coreTheme, 700) ||
    cleanText(result.optimizedScript, 700) ||
    cleanText(originalScript, 700) ||
    "";
  const endingState =
    cleanText(lastShot?.shotPurpose || lastShot?.visual || lastShot?.lastFramePrompt, 300) ||
    "";
  const characterState = cleanText(diagnosis?.characterState, 240) || emotions.join("、").slice(0, 240);
  const memoryJson = {
    diagnosis,
    contentType: result.contentType,
    style: result.style,
    duration: result.duration,
    emotions,
    sceneKeywords,
    visualFocus,
    cameraMovements,
    transitions,
    avoid,
    shots: shots.map((shot) => ({
      shotNumber: shot.shotNumber,
      scene: cleanText(shot.scene, 120),
      visual: cleanText(shot.visual, 160),
      shotType: cleanText(shot.shotType, 60),
      cameraMovement: cleanText(shot.cameraMovement, 80),
      emotion: cleanText(shot.emotion, 80),
      transition: cleanText(shot.transition, 80),
    })),
  };
  const stateVector = {
    mysteryProgress: Math.min(1, Math.max(0.15, (sceneKeywords.length + visualFocus.length) / 20)),
    tension: getToneScore(emotions, [/紧张|压抑|惊悚|悬疑|危险|焦虑|恐惧/]),
    fear: getToneScore(emotions, [/恐惧|惊悚|害怕|不安|危险|压迫/]),
    hope: getToneScore(emotions, [/希望|释然|温暖|治愈|平静/]),
    pacing: shots.length >= 4 ? 0.7 : 0.45,
  };
  const openLoops = uniqueStrings([
    ...visualFocus,
    ...sceneKeywords,
    endingState,
  ], 8);
  const storyBible = {
    genre: diagnosis?.genre || result.contentType,
    visualStyle: result.style,
    emotionalTone: emotions,
    sceneKeywords,
    visualFocus,
    cameraStyle: cameraMovements,
    transitions,
    forbidden: avoid,
    currentState: endingState,
    characterState,
    keyEvents: episodeSummary ? [episodeSummary] : [],
  };
  const narrativeMemory = {
    episodeSummary,
    endingState,
    characterState,
    stateVector,
    openLoops,
    characters: characterState
      ? [{
          name: "Main character",
          role: "protagonist",
          personality: characterState,
          importance: 0.75,
        }]
      : [],
    storyLoops: openLoops.map((loop) => ({
      title: loop,
      description: loop,
      importance: 0.6,
    })),
    memoryItems: [
      episodeSummary ? {
        type: "EVENT",
        title: result.title,
        content: episodeSummary,
        keywords: [result.title, result.contentType, ...emotions],
        importance: 0.8,
      } : null,
      endingState ? {
        type: "CLUE",
        title: "Ending state",
        content: endingState,
        keywords: [...visualFocus, ...sceneKeywords],
        importance: 0.85,
      } : null,
    ].filter(Boolean),
  };
  const qualityCheck = {
    status: "unchecked",
    characterConsistency: characterState ? "tracked" : "not_enough_character_data",
    loopContinuity: openLoops.length ? "open_loops_tracked" : "no_open_loops_detected",
    previousEndingContinuity: "not_checked_by_ai",
    issues: [],
    suggestions: [],
  };

  return {
    storyBible,
    episodeSummary,
    endingState,
    characterState,
    memoryJson,
    narrativeMemory: result.narrativeMemory || narrativeMemory,
    stateVector,
    openLoops,
    qualityCheck: result.qualityCheck || qualityCheck,
    contextSummary: [storyBible.genre, storyBible.visualStyle, endingState].filter(Boolean).join(" · "),
  };
}

function getLocalProjectStoryboardPaths(project: unknown) {
  const projectRecord = project && typeof project === "object" ? project as Record<string, unknown> : null;
  const versions = Array.isArray(projectRecord?.versions) ? projectRecord.versions : [];
  const storyboardRoot = path.resolve(process.cwd(), "public", "project-assets", "storyboards");
  const filePaths = new Set<string>();

  for (const version of versions) {
    const versionRecord = version && typeof version === "object" ? version as Record<string, unknown> : null;
    const storyboardImageUrl = versionRecord ? versionRecord.storyboardImageUrl : undefined;
    if (typeof storyboardImageUrl !== "string") continue;

    const urlPath = storyboardImageUrl.split(/[?#]/)[0];
    if (!urlPath.startsWith("/project-assets/storyboards/")) continue;

    const absolutePath = path.resolve(process.cwd(), "public", urlPath.slice(1));
    if (absolutePath !== storyboardRoot && absolutePath.startsWith(`${storyboardRoot}${path.sep}`)) {
      filePaths.add(absolutePath);
    }
  }

  return [...filePaths];
}

async function deleteLocalProjectStoryboardImages(project: unknown) {
  await Promise.all(
    getLocalProjectStoryboardPaths(project).map(async (filePath) => {
      try {
        await unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Project deletion should not fail because a local preview file was already removed.
        }
      }
    }),
  );
}

export function mapAnalysisResultToNestProjectBody(input: Record<string, unknown>) {
  const payload = input as ProjectCreatePayload;
  if (!payload.result) {
    return input;
  }
  const memory = deriveProjectMemoryFromAnalysis(payload.originalScript, payload.result);

  return {
    idempotencyKey: payload.idempotencyKey,
    projectId: payload.projectId,
    versionId: payload.versionId,
    title: deriveProjectSaveTitle(payload),
    originalScript: payload.originalScript || "",
    optimizedScript: payload.result.optimizedScript,
    contentType: cleanText(payload.result.contentType, 80) || "短剧 / 通用",
    style: cleanText(payload.result.style, 120) || "通用",
    duration: deriveProjectSaveDuration(payload.result),
    status: payload.status || "draft",
    storyboardImageUrl: payload.storyboardImageUrl,
    storyboardImagePrompt: payload.storyboardImagePrompt,
    fullVideoPrompt: deriveProjectSaveFullVideoPrompt(payload),
    storyBible: payload.storyBible || memory.storyBible,
    contextSummary: payload.contextSummary || memory.contextSummary,
    episodeSummary: payload.episodeSummary || memory.episodeSummary,
    endingState: payload.endingState || memory.endingState,
    characterState: payload.characterState || memory.characterState,
    memoryJson: payload.memoryJson || memory.memoryJson,
    narrativeMemory: payload.narrativeMemory || memory.narrativeMemory,
    stateVector: payload.stateVector || memory.stateVector,
    openLoops: payload.openLoops || memory.openLoops,
    qualityCheck: payload.qualityCheck || memory.qualityCheck,
    contextSnapshot: payload.contextSnapshot || (payload.directorContext ? { directorContext: payload.directorContext } : undefined),
    shots: payload.result.storyboard.map(mapShotToNestProjectBody),
  };
}

export async function fetchDirectorContextFromNest(request: NextRequest, projectId: string | undefined, currentScript: string) {
  const token = getBearerToken(request);
  if (!token || !projectId) return "";

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${projectId}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ currentScript }),
    cache: "no-store",
  });
  const payload = await readJson(upstream);
  if (!upstream.ok || !payload || !payload.ok) return "";

  const data = getNestResponseData(payload);
  return typeof data?.contextText === "string" ? data.contextText : "";
}

export async function proxyNestProjectsGet(request: NextRequest) {
  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    return NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Projects service request failed") },
      { status: upstream.status || 502 },
    );
  }

  const data = getNestResponseData(payload);
  return NextResponse.json({ ok: true, projects: data ? data.projects || [] : [] });
}

export async function proxyNestProjectGet(request: NextRequest, projectId: string) {
  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${projectId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    const error =
      upstream.status === 404
        ? "Project detail endpoint is unavailable. Restart the Nest API with npm run api:dev, then refresh this page."
        : formatUpstreamError(payload, "Project detail request failed");
    return NextResponse.json(
      { ok: false, error },
      { status: upstream.status || 502 },
    );
  }

  const data = getNestResponseData(payload);
  return NextResponse.json({ ok: true, project: data ? data.project || null : null });
}

export async function proxyNestProjectDelete(request: NextRequest, projectId: string) {
  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let projectBeforeDelete: unknown = null;
  const detailUpstream = await fetch(`${getNestApiBaseUrl()}/projects/${projectId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const detailPayload = await readJson(detailUpstream);
  if (detailUpstream.ok && detailPayload && detailPayload.ok) {
    const detailData = getNestResponseData(detailPayload);
    projectBeforeDelete = detailData ? detailData.project || null : null;
  }

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${projectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    const error =
      upstream.status === 404
        ? "Project delete endpoint is unavailable. Restart the Nest API with npm run api:dev, then refresh this page."
        : formatUpstreamError(payload, "Project delete request failed");
    return NextResponse.json(
      { ok: false, error },
      { status: upstream.status || 502 },
    );
  }

  await deleteLocalProjectStoryboardImages(projectBeforeDelete);

  return NextResponse.json({ ok: true, delete: getNestResponseData(payload) || { deleted: true, projectId } });
}

export async function proxyNestProjectVersionDelete(request: NextRequest, projectId: string, versionId: string) {
  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${projectId}/versions/${versionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    const error =
      upstream.status === 404
        ? "Project episode delete endpoint is unavailable. Restart the Nest API with npm run api:dev, then refresh this page."
        : formatUpstreamError(payload, "Project episode delete request failed");
    return NextResponse.json(
      { ok: false, error },
      { status: upstream.status || 502 },
    );
  }

  return NextResponse.json({ ok: true, delete: getNestResponseData(payload) || { deleted: true, projectId, versionId } });
}

export async function proxyNestProjectPatch(request: NextRequest, projectId: string, subPath: string) {
  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const cleanSubPath = subPath.replace(/^\/+|\/+$/g, "");
  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${projectId}/${cleanSubPath}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    return NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Project memory update failed") },
      { status: upstream.status || 502 },
    );
  }

  return NextResponse.json({ ok: true, data: getNestResponseData(payload) || { saved: true } });
}

export async function proxyNestProjectsPost(request: NextRequest) {
  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = mapAnalysisResultToNestProjectBody((await request.json()) as Record<string, unknown>);
  const { upstream, payload } = await postProjectToNestWithCompatibility(token, body);

  if (!upstream.ok || !payload || !payload.ok) {
    return NextResponse.json(
      { ok: false, error: formatUpstreamError(payload, "Project save failed") },
      { status: upstream.status || 502 },
    );
  }

  return NextResponse.json({ ok: true, save: getNestResponseData(payload) || { saved: true } });
}

export async function saveAnalysisProjectToNest(
  request: NextRequest,
  originalScript: string,
  result: AnalysisResult,
  projectId: string | undefined = undefined,
  versionId: string | undefined = undefined,
) {
  const token = getBearerToken(request);
  if (!token) return { saved: false, reason: "Unauthorized" };

  const body = mapAnalysisResultToNestProjectBody({ projectId, versionId, originalScript, result });
  const { upstream, payload } = await postProjectToNestWithCompatibility(token, body);

  if (!upstream.ok || !payload || !payload.ok) {
    return {
      saved: false,
      reason: formatUpstreamError(payload, "Project save failed"),
    };
  }

  return getNestResponseData(payload) || { saved: true };
}

export async function saveStoryboardImageToNest(
  request: NextRequest,
  input: { projectId: string; versionId: string; storyboardImageUrl: string; storyboardImagePrompt: string | undefined },
) {
  const token = getBearerToken(request);
  if (!token) return { saved: false, reason: "Unauthorized" };

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${input.projectId}/versions/${input.versionId}/storyboard-image`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      storyboardImageUrl: input.storyboardImageUrl,
      storyboardImagePrompt: input.storyboardImagePrompt,
    }),
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    return {
      saved: false,
      reason: formatUpstreamError(payload, "Storyboard image save failed"),
    };
  }

  return getNestResponseData(payload) || { saved: true };
}

export async function saveVisualAssetsToNest(
  request: NextRequest,
  input: {
    projectId: string;
    versionId: string;
    visualAssets: Array<Record<string, unknown> & {
      type: string;
      name: string;
    }>;
  },
) {
  const token = getBearerToken(request);
  if (!token) return { saved: false, reason: "Unauthorized" };

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${input.projectId}/versions/${input.versionId}/visual-assets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ visualAssets: input.visualAssets }),
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    return {
      saved: false,
      reason: formatUpstreamError(payload, "Visual asset save failed"),
    };
  }

  return getNestResponseData(payload) || { saved: true };
}

export async function saveProjectVisualEntitiesToNest(
  request: NextRequest,
  input: {
    projectId: string;
    visualEntities: Array<Record<string, unknown> & {
      type: string;
      name: string;
    }>;
  },
) {
  const token = getBearerToken(request);
  if (!token) return { saved: false, reason: "Unauthorized" };

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${input.projectId}/visual-entities`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ visualEntities: input.visualEntities }),
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    return {
      saved: false,
      reason: formatUpstreamError(payload, "Project visual entity save failed"),
    };
  }

  return getNestResponseData(payload) || { saved: true };
}

export async function saveShotVisualReferencesToNest(
  request: NextRequest,
  input: {
    projectId: string;
    versionId: string;
    visualReferences: Array<Record<string, unknown> & {
      entityId: string;
    }>;
  },
) {
  const token = getBearerToken(request);
  if (!token) return { saved: false, reason: "Unauthorized" };

  const upstream = await fetch(`${getNestApiBaseUrl()}/projects/${input.projectId}/versions/${input.versionId}/visual-references`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ visualReferences: input.visualReferences }),
    cache: "no-store",
  });
  const payload = await readJson(upstream);

  if (!upstream.ok || !payload || !payload.ok) {
    return {
      saved: false,
      reason: formatUpstreamError(payload, "Shot visual reference save failed"),
    };
  }

  return getNestResponseData(payload) || { saved: true };
}
