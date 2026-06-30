import { BadRequestException, Injectable } from "@nestjs/common";
import {
  MemoryItemType,
  ShotVisualReferenceRole,
  StoryLoopStatus,
  VisualAssetStatus,
  VisualAssetType,
  VisualEntityStatus,
  VisualEntityType,
} from "@prisma/client";
import type { Prisma, Project } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type {
  CreateProjectDto,
  SaveStoryboardImageDto,
  SaveProjectVisualEntitiesDto,
  SaveShotVisualReferencesDto,
  SaveVisualAssetsDto,
  UpdateCharacterProfileDto,
  UpdateMemoryItemDto,
  UpdateProjectMemoryDto,
  UpdateStoryLoopDto,
} from "./projects.dto";

type JsonRecord = Record<string, unknown>;

type ProjectVisualEntityInput = {
  id?: string;
  type: string;
  key?: string;
  name: string;
  aliases?: string[];
  canonicalPrompt?: string;
  visualLock?: string;
  negativeLock?: string;
  status?: string;
  primaryAssetId?: string;
  metadata?: Record<string, unknown>;
};

const DEFAULT_PROMPT_PREFERENCES: JsonRecord = {
  language: "zh-CN",
  aspectRatio: "16:9",
  frameRate: "24fps",
  output: ["video_prompt", "storyboard", "docx"],
};

const MEMORY_RETRIEVAL_LIMIT = 8;

function cleanText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function visualEntityKey(value: unknown, fallback: unknown) {
  const source = cleanText(value, 120) || cleanText(fallback, 120) || "visual-entity";
  return source
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "visual-entity";
}

function compactText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s#，。、：“”‘’：:,.!?！？\-_/]+/g, "");
}

function uniqueStrings(values: Array<unknown>, limit = 12) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = cleanText(value, 80);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function pickRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asStringArray(value: unknown, limit = 20) {
  return Array.isArray(value) ? uniqueStrings(value, limit) : [];
}

function asNumber(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value: unknown, fallback = 0.5) {
  return Math.min(1, Math.max(0, asNumber(value, fallback)));
}

function asNumberArray(value: unknown, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .slice(0, limit);
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildLocalEmbedding(value: unknown, dimensions = 64) {
  const text = String(value || "").toLowerCase();
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{3,}/gi) || [];
  for (const token of tokens) {
    const hash = hashText(token);
    const index = hash % dimensions;
    vector[index] += (hash % 2 === 0 ? 1 : -1) * Math.min(1, token.length / 12);
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => Number((item / norm).toFixed(6)));
}

function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(0, dot / Math.sqrt(leftNorm * rightNorm));
}

function formatPgVector(vector: number[]) {
  const values = asNumberArray(vector, 64);
  return `[${values.map((item) => Number(item.toFixed(6))).join(",")}]`;
}

type MemoryVectorRow = {
  id: string;
  type: MemoryItemType;
  title: string | null;
  content: string;
  keywords: Prisma.JsonValue | null;
  importance: number;
  recency: number;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  semanticScore?: number | string | null;
};

async function syncMemoryEmbeddingVectors(prisma: Prisma.TransactionClient, versionId: string) {
  try {
    const rows = await prisma.memoryItem.findMany({
      where: { versionId, isEnabled: true },
      select: { id: true, content: true, embedding: true },
    });

    for (const row of rows) {
      const embedding = asNumberArray(row.embedding).length
        ? asNumberArray(row.embedding)
        : buildLocalEmbedding(row.content);
      await prisma.$executeRawUnsafe(
        'UPDATE "MemoryItem" SET "embeddingVector" = $1::vector WHERE "id" = $2',
        formatPgVector(embedding),
        row.id,
      );
    }
  } catch {
    // pgvector is optional. JSON embeddings remain the fallback retrieval path.
  }
}

function deriveEpisodeMemory(input: CreateProjectDto) {
  const shots = input.shots || [];
  const lastShot = shots.length ? shots[shots.length - 1] : undefined;
  const emotions = uniqueStrings(shots.flatMap((shot) => [shot.emotion]));
  const scenes = uniqueStrings(shots.flatMap((shot) => [shot.scene]));
  const visualFocus = uniqueStrings(shots.flatMap((shot) => [shot.visual]), 8);
  const cameraMovements = uniqueStrings(shots.flatMap((shot) => [shot.cameraMovement]));
  const transitions = uniqueStrings(shots.flatMap((shot) => [shot.transition]));
  const negativePrompts = uniqueStrings(shots.flatMap((shot) => [shot.negativePrompt]), 8);

  const episodeSummary =
    cleanText(input.episodeSummary, 700) ||
    cleanText(input.optimizedScript, 700) ||
    cleanText(input.originalScript, 700) ||
    "";
  const endingState =
    cleanText(input.endingState, 300) ||
    cleanText(lastShot?.visual || lastShot?.scene || lastShot?.videoPrompt, 300) ||
    "";
  const characterState =
    cleanText(input.characterState, 240) ||
    (emotions.length ? emotions.join("、").slice(0, 240) : "");

  const memoryJson = pickRecord(input.memoryJson);
  return {
    episodeSummary,
    endingState,
    characterState,
    memoryJson: {
      title: input.title,
      contentType: input.contentType,
      style: input.style,
      duration: input.duration,
      emotions,
      scenes,
      visualFocus,
      cameraMovements,
      transitions,
      negativePrompts,
      shots: shots.map((shot) => ({
        shotNumber: shot.shotNumber,
        scene: cleanText(shot.scene, 120),
        visual: cleanText(shot.visual, 160),
        shotType: cleanText(shot.shotType, 60),
        cameraMovement: cleanText(shot.cameraMovement, 80),
        emotion: cleanText(shot.emotion, 80),
        transition: cleanText(shot.transition, 80),
      })),
      ...memoryJson,
    } satisfies JsonRecord,
  };
}

function asRecords(value: unknown, limit = 20) {
  return Array.isArray(value)
    ? value
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .slice(0, limit) as JsonRecord[]
    : [];
}

function deriveNarrativeMemory(input: CreateProjectDto, memory: ReturnType<typeof deriveEpisodeMemory>) {
  const explicit = pickRecord(input.narrativeMemory);
  const memoryJson = pickRecord(memory.memoryJson);
  const explicitStateVector = pickRecord(explicit.stateVector);
  const explicitOpenLoops = asStringArray(explicit.openLoops, 20);
  const baseStateVector = deriveStateVector(input, memory);
  const baseOpenLoops = deriveOpenLoops(input, memory);
  const characters = asRecords(explicit.characters, 20);
  const storyLoops = asRecords(explicit.storyLoops, 20);
  const memoryItems = asRecords(explicit.memoryItems, 40);
  const resolvedLoops = asStringArray(explicit.resolvedLoops, 20);

  const fallbackCharacter =
    cleanText(memory.characterState, 200)
      ? [{
          name: cleanText(pickRecord(memoryJson).mainCharacter, 80) || "Main character",
          role: "protagonist",
          appearance: cleanText(input.storyBible?.mainCharacter, 220),
          personality: cleanText(memory.characterState, 220),
          importance: 0.75,
        }]
      : [];

  return {
    episodeSummary: cleanText(explicit.episodeSummary, 900) || memory.episodeSummary,
    endingState: cleanText(explicit.endingState, 400) || memory.endingState,
    characterState: cleanText(explicit.characterState, 300) || memory.characterState,
    stateVector: {
      ...baseStateVector,
      ...explicitStateVector,
    },
    openLoops: uniqueStrings([...explicitOpenLoops, ...baseOpenLoops], 20),
    characters: characters.length ? characters : fallbackCharacter,
    storyLoops,
    resolvedLoops,
    memoryItems,
  } satisfies JsonRecord;
}

function deriveStateVector(input: CreateProjectDto, memory: ReturnType<typeof deriveEpisodeMemory>) {
  const explicit = pickRecord(input.stateVector);
  const memoryJson = pickRecord(memory.memoryJson);
  const emotions = asStringArray(memoryJson.emotions);
  const hasTone = (patterns: RegExp[]) => emotions.some((emotion) => patterns.some((pattern) => pattern.test(emotion)));
  const shotCount = input.shots?.length || 0;

  return {
    mysteryProgress: Math.min(1, Math.max(0.15, asStringArray(memoryJson.scenes).length / 10)),
    tension: hasTone([/紧张|压抑|惊悚|悬疑|危险|焦虑|恐惧/]) ? 0.75 : 0.35,
    fear: hasTone([/恐惧|惊悚|害怕|不安|危险|压迫/]) ? 0.7 : 0.25,
    hope: hasTone([/希望|释然|温暖|治愈|平静/]) ? 0.65 : 0.2,
    pacing: shotCount >= 4 ? 0.7 : 0.45,
    ...explicit,
  } satisfies JsonRecord;
}

function deriveOpenLoops(input: CreateProjectDto, memory: ReturnType<typeof deriveEpisodeMemory>) {
  const explicit = uniqueStrings(input.openLoops || [], 12);
  if (explicit.length) return explicit;

  const memoryJson = pickRecord(memory.memoryJson);
  return uniqueStrings([
    ...(asStringArray(memoryJson.visualFocus, 8)),
    ...(asStringArray(memoryJson.scenes, 8)),
    memory.endingState,
  ], 12);
}

function makeMemoryItem(params: {
  userId: string;
  projectId: string;
  versionId: string;
  type: MemoryItemType;
  title: string;
  content: string | undefined;
  keywords?: unknown[];
  importance?: number;
  recency?: number;
  metadata?: JsonRecord;
}): Prisma.MemoryItemCreateManyInput | null {
  const content = cleanText(params.content, 700);
  if (!content) return null;

  return {
    userId: params.userId,
    projectId: params.projectId,
    versionId: params.versionId,
    type: params.type,
    title: cleanText(params.title, 120),
    content,
    keywords: toJson(uniqueStrings(params.keywords || [], 16)),
    importance: params.importance ?? 0.5,
    recency: params.recency ?? 1,
    metadata: toJson(params.metadata),
    embedding: toJson(buildLocalEmbedding(content)),
    isEnabled: true,
    source: "episode_extractor",
  };
}

function deriveMemoryItems(
  input: CreateProjectDto,
  memory: ReturnType<typeof deriveEpisodeMemory>,
  projectId: string,
  userId: string,
  versionId: string,
) {
  const memoryJson = pickRecord(memory.memoryJson);
  const scenes = asStringArray(memoryJson.scenes, 8);
  const visualFocus = asStringArray(memoryJson.visualFocus, 8);
  const emotions = asStringArray(memoryJson.emotions, 8);
  const cameraMovements = asStringArray(memoryJson.cameraMovements, 8);
  const transitions = asStringArray(memoryJson.transitions, 8);
  const explicitMemoryItems = asRecords(pickRecord(input.narrativeMemory).memoryItems, 40);
  const base = { userId, projectId, versionId };
  const items: Array<Prisma.MemoryItemCreateManyInput | null> = [
    makeMemoryItem({
      ...base,
      type: MemoryItemType.EVENT,
      title: `Episode ${input.title}`,
      content: memory.episodeSummary,
      keywords: [input.title, input.contentType, ...emotions],
      importance: 0.8,
    }),
    makeMemoryItem({
      ...base,
      type: MemoryItemType.CHARACTER,
      title: "Character state",
      content: memory.characterState,
      keywords: emotions,
      importance: 0.7,
    }),
    makeMemoryItem({
      ...base,
      type: MemoryItemType.CLUE,
      title: "Ending state",
      content: memory.endingState,
      keywords: [...visualFocus, ...scenes],
      importance: 0.85,
    }),
    makeMemoryItem({
      ...base,
      type: MemoryItemType.STYLE,
      title: "Visual style",
      content: [input.style, input.contentType, ...cameraMovements, ...transitions].filter(Boolean).join(" "),
      keywords: [input.style, input.contentType, ...cameraMovements, ...transitions],
      importance: 0.55,
    }),
    makeMemoryItem({
      ...base,
      type: MemoryItemType.QUALITY_CHECK,
      title: "Quality check",
      content: JSON.stringify(pickRecord(input.qualityCheck || pickRecord(input.narrativeMemory).qualityCheck || {})),
      keywords: ["quality", "consistency", input.title],
      importance: 0.45,
      metadata: { source: "quality_check" },
    }),
  ];

  for (const scene of scenes) {
    items.push(makeMemoryItem({
      ...base,
      type: MemoryItemType.SCENE,
      title: "Scene",
      content: scene,
      keywords: [scene, input.contentType, input.style],
      importance: 0.6,
    }));
  }

  for (const focus of visualFocus) {
    items.push(makeMemoryItem({
      ...base,
      type: MemoryItemType.OBJECT,
      title: "Visual focus",
      content: focus,
      keywords: [focus, input.contentType, input.style],
      importance: 0.65,
    }));
  }

  for (const item of explicitMemoryItems) {
    const typeText = cleanText(item.type, 40)?.toUpperCase();
    const type = typeText && typeText in MemoryItemType
      ? MemoryItemType[typeText as keyof typeof MemoryItemType]
      : MemoryItemType.EVENT;
    items.push(makeMemoryItem({
      ...base,
      type,
      title: cleanText(item.title, 120) || "Narrative memory",
      content: cleanText(item.content, 700),
      keywords: asStringArray(item.keywords, 16),
      importance: clamp01(item.importance, 0.65),
      metadata: {
        source: "narrative_memory",
        ...pickRecord(item.metadata),
      },
    }));
  }

  return items.filter(Boolean) as Prisma.MemoryItemCreateManyInput[];
}

function scoreMemoryItem(memory: {
  title: string | null;
  content: string;
  keywords: Prisma.JsonValue | null;
  importance: number;
  recency: number;
  metadata: Prisma.JsonValue | null;
  embedding?: Prisma.JsonValue | null;
}, currentScript: string, index = 0, queryEmbedding = buildLocalEmbedding(currentScript)) {
  const script = compactText(currentScript);
  if (!script) return 0;

  const keywords = asStringArray(memory.keywords, 20);
  const haystack = compactText([memory.title, memory.content, keywords.join(" "), JSON.stringify(memory.metadata || {})].join(" "));
  const tokens = Array.from(new Set(script.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{3,}/gi) || []));
  let matches = 0;
  for (const token of tokens) {
    if (haystack.includes(compactText(token))) matches += 1;
  }

  const relevance = tokens.length ? Math.min(1, matches / Math.min(tokens.length, 12)) : 0;
  const semantic = cosineSimilarity(asNumberArray(memory.embedding), queryEmbedding);
  const recency = Math.max(memory.recency || 0, 1 / (index + 1));
  return memory.importance * 0.5 + Math.max(relevance, semantic) * 0.4 + recency * 0.1;
}

function appendUnique(existing: unknown, additions: unknown[], limit = 30) {
  return uniqueStrings([...(Array.isArray(existing) ? existing : []), ...additions], limit);
}

function deriveCharacterProfiles(input: CreateProjectDto, narrativeMemory: JsonRecord) {
  const characters = asRecords(narrativeMemory.characters, 20);
  return characters
    .map((character) => ({
      name: cleanText(character.name, 80) || cleanText(character.title, 80),
      aliases: asStringArray(character.aliases, 12),
      role: cleanText(character.role, 120),
      appearance: cleanText(character.appearance, 500),
      personality: cleanText(character.personality || character.characterState, 500),
      relationshipState: cleanText(character.relationshipState, 500),
      visualLock: cleanText(character.visualLock || character.consistencyLock, 700),
      referenceImageUrl: cleanText(character.referenceImageUrl, 500),
      importance: clamp01(character.importance, 0.6),
      locked: Boolean(character.locked),
      metadata: {
        sourceTitle: input.title,
        contentType: input.contentType,
        style: input.style,
        raw: character,
      },
    }))
    .filter((character) => character.name);
}

function deriveProjectVisualEntities(
  input: CreateProjectDto,
  narrativeMemory: JsonRecord,
  memory: ReturnType<typeof deriveEpisodeMemory>,
) {
  const memoryJson = pickRecord(memory.memoryJson);
  const entities: ProjectVisualEntityInput[] = [];
  const seen = new Set<string>();

  function addEntity(entity: ProjectVisualEntityInput) {
    const name = cleanText(entity.name, 160);
    if (!name) return;
    const key = visualEntityKey(entity.key, name);
    const uniqueKey = `${entity.type}:${key}`;
    if (seen.has(uniqueKey)) return;
    seen.add(uniqueKey);
    entities.push({
      ...entity,
      key,
      name,
      status: entity.status || VisualEntityStatus.CANDIDATE,
    });
  }

  for (const character of asRecords(narrativeMemory.characters, 20)) {
    const name = cleanText(character.name, 120) || cleanText(character.title, 120);
    if (!name) continue;
    addEntity({
      type: VisualEntityType.CHARACTER,
      key: cleanText(character.key, 120) || name,
      name,
      aliases: asStringArray(character.aliases, 12),
      canonicalPrompt: cleanText(character.appearance || character.description || character.personality, 1200),
      visualLock: cleanText(character.visualLock || character.consistencyLock || character.appearance, 1600),
      negativeLock: cleanText(character.negativeLock || character.avoid, 1200),
      status: character.locked ? VisualEntityStatus.LOCKED : VisualEntityStatus.CANDIDATE,
      metadata: {
        source: "narrativeMemory.characters",
        role: cleanText(character.role, 120),
        sourceTitle: input.title,
      },
    });
  }

  for (const scene of asStringArray(memoryJson.scenes, 12)) {
    addEntity({
      type: VisualEntityType.SCENE,
      key: scene,
      name: scene,
      canonicalPrompt: scene,
      visualLock: [scene, input.style, input.contentType].filter(Boolean).join(" · "),
      negativeLock: "不要改变项目核心空间布局、时代质感、主色和材质方向。",
      status: VisualEntityStatus.CANDIDATE,
      metadata: {
        source: "memoryJson.scenes",
        sourceTitle: input.title,
      },
    });
  }

  for (const focus of asStringArray(memoryJson.visualFocus, 16)) {
    addEntity({
      type: VisualEntityType.PROP,
      key: focus,
      name: focus,
      canonicalPrompt: focus,
      visualLock: [focus, input.style].filter(Boolean).join(" · "),
      negativeLock: "不要改变道具外观、比例、功能和在镜头中的识别特征。",
      status: VisualEntityStatus.CANDIDATE,
      metadata: {
        source: "memoryJson.visualFocus",
        sourceTitle: input.title,
      },
    });
  }

  if (cleanText(input.style, 240)) {
    addEntity({
      type: VisualEntityType.STYLE,
      key: "project-style",
      name: "项目风格锁定",
      canonicalPrompt: [input.style, input.contentType, input.duration].filter(Boolean).join(" · "),
      visualLock: cleanText(input.style, 1200),
      negativeLock: "不要偏离项目既定风格、色彩、镜头语气和画面质感。",
      status: VisualEntityStatus.CANDIDATE,
      metadata: {
        source: "project.style",
        sourceTitle: input.title,
      },
    });
  }

  return entities.slice(0, 80);
}

function deriveStoryLoops(input: CreateProjectDto, narrativeMemory: JsonRecord) {
  const openLoopRecords = asRecords(narrativeMemory.storyLoops, 20);
  const openLoopStrings = asStringArray(narrativeMemory.openLoops, 20);
  const openLoops = [
    ...openLoopRecords.map((loop) => ({
      title: cleanText(loop.title, 140) || cleanText(loop.content, 140),
      description: cleanText(loop.description || loop.content, 700),
      importance: clamp01(loop.importance, 0.65),
      evidence: loop.evidence,
      metadata: {
        sourceTitle: input.title,
        raw: loop,
      },
    })),
    ...openLoopStrings.map((loop) => ({
      title: loop,
      description: loop,
      importance: 0.6,
      evidence: undefined,
      metadata: { sourceTitle: input.title },
    })),
  ].filter((loop) => loop.title);

  const resolvedLoops = asStringArray(narrativeMemory.resolvedLoops, 20).map((title) => ({
    title,
    status: StoryLoopStatus.RESOLVED,
  }));

  return { openLoops, resolvedLoops };
}

function deriveQualityCheck(input: CreateProjectDto, narrativeMemory: JsonRecord) {
  const explicit = pickRecord(input.qualityCheck);
  const stateVector = pickRecord(narrativeMemory.stateVector);
  const openLoops = asStringArray(narrativeMemory.openLoops, 20);
  const characters = asRecords(narrativeMemory.characters, 20);

  return {
    status: cleanText(explicit.status, 40) || "unchecked",
    characterConsistency: explicit.characterConsistency ?? (characters.length ? "tracked" : "not_enough_character_data"),
    loopContinuity: explicit.loopContinuity ?? (openLoops.length ? "open_loops_tracked" : "no_open_loops_detected"),
    pacingRisk: explicit.pacingRisk ?? (clamp01(stateVector.tension, 0.5) > 0.85 ? "high_tension" : "normal"),
    previousEndingContinuity: explicit.previousEndingContinuity ?? "not_checked_by_ai",
    issues: asStringArray(explicit.issues, 20),
    suggestions: asStringArray(explicit.suggestions, 20),
  } satisfies JsonRecord;
}

function mergeStoryBible(existingValue: unknown, input: CreateProjectDto, memory: ReturnType<typeof deriveEpisodeMemory>): JsonRecord {
  const existing = pickRecord(existingValue);
  const inputBible = pickRecord(input.storyBible);
  const memoryJson = pickRecord(memory.memoryJson);

  return {
    ...existing,
    ...inputBible,
    genre: input.contentType || inputBible.genre || existing.genre,
    visualStyle: input.style || inputBible.visualStyle || existing.visualStyle,
    defaultDuration: input.duration || existing.defaultDuration,
    currentState: memory.endingState || existing.currentState,
    characterState: memory.characterState || existing.characterState,
    keyEvents: appendUnique(existing.keyEvents, [memory.episodeSummary], 40),
    unresolvedClues: appendUnique(existing.unresolvedClues, [
      ...(Array.isArray(memoryJson.visualFocus) ? memoryJson.visualFocus : []),
      ...(Array.isArray(memoryJson.scenes) ? memoryJson.scenes : []),
    ], 40),
    emotions: appendUnique(existing.emotions, Array.isArray(memoryJson.emotions) ? memoryJson.emotions : [], 30),
    cameraStyle: appendUnique(existing.cameraStyle, Array.isArray(memoryJson.cameraMovements) ? memoryJson.cameraMovements : [], 30),
    transitions: appendUnique(existing.transitions, Array.isArray(memoryJson.transitions) ? memoryJson.transitions : [], 30),
    forbidden: appendUnique(existing.forbidden, Array.isArray(memoryJson.negativePrompts) ? memoryJson.negativePrompts : [], 30),
  } satisfies JsonRecord;
}

function buildContextSummary(storyBible: JsonRecord, memory: ReturnType<typeof deriveEpisodeMemory>) {
  return [
    cleanText(storyBible.genre, 80),
    cleanText(storyBible.visualStyle, 120),
    cleanText(memory.endingState, 180),
  ]
    .filter(Boolean)
    .join(" · ");
}

function scoreEpisodeMemory(version: {
  versionNumber: number;
  title: string;
  originalScript: string;
  episodeSummary: string | null;
  endingState: string | null;
  characterState: string | null;
  memoryJson: Prisma.JsonValue | null;
}, currentScript: string) {
  const script = compactText(currentScript);
  const memory = pickRecord(version.memoryJson);
  const haystack = compactText([
    version.title,
    version.originalScript,
    version.episodeSummary,
    version.endingState,
    version.characterState,
    JSON.stringify(memory),
  ].join(" "));
  if (!script || !haystack) return 0;

  const tokens = Array.from(new Set(script.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{3,}/gi) || []));
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(compactText(token))) score += 1;
  }
  return score;
}

function stringifyContextBlock(title: string, lines: string[]) {
  const body = lines.filter(Boolean).join("\n");
  return body ? `【${title}】\n${body}` : "";
}

function buildDirectorContextText(input: {
  userPreferences: JsonRecord;
  storyBible: JsonRecord;
  contextSummary: string | null;
  stateVector: JsonRecord;
  openLoops: string[];
  recentEpisodes: Array<Record<string, unknown>>;
  relatedEpisodes: Array<Record<string, unknown>>;
  relatedMemories: Array<Record<string, unknown>>;
}) {
  const preferenceLines = Object.entries(input.userPreferences).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join("、") : String(value)}`);
  const storyLines = Object.entries(input.storyBible)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join("、") : String(value)}`);
  const recentLines = input.recentEpisodes.map((episode) => [
    `第 ${episode.versionNumber} 集：${episode.episodeSummary || episode.title || ""}`,
    episode.endingState ? `结尾状态：${episode.endingState}` : "",
    episode.characterState ? `人物状态：${episode.characterState}` : "",
  ].filter(Boolean).join("\n"));
  const relatedLines = input.relatedEpisodes.map((episode) => [
    `第 ${episode.versionNumber} 集：${episode.episodeSummary || episode.title || ""}`,
    episode.endingState ? `相关承接：${episode.endingState}` : "",
  ].filter(Boolean).join("\n"));
  const stateLines = Object.entries(input.stateVector)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${String(value)}`);
  const openLoopLines = input.openLoops.map((loop, index) => `${index + 1}. ${loop}`);
  const memoryLines = input.relatedMemories.map((memory) => [
    `${memory.type || "MEMORY"}：${memory.title || ""}`,
    memory.content ? String(memory.content) : "",
    memory.relevanceScore ? `score: ${memory.relevanceScore}` : "",
  ].filter(Boolean).join("\n"));

  return [
    stringifyContextBlock("用户长期偏好", preferenceLines),
    stringifyContextBlock("项目剧集圣经", [
      input.contextSummary ? `摘要：${input.contextSummary}` : "",
      ...storyLines,
    ]),
    stringifyContextBlock("最近剧集摘要", recentLines),
    stringifyContextBlock("相关历史片段", relatedLines),
    stringifyContextBlock("剧情状态向量", stateLines),
    stringifyContextBlock("未解决伏笔", openLoopLines),
    stringifyContextBlock("相关记忆 Top-K", memoryLines),
    stringifyContextBlock("上下文使用规则", [
      "这些内容只用于保持连续性、人物状态、地点道具和视觉风格一致。",
      "优先服务当前用户输入，不要机械复述历史剧情。",
      "不要把完整历史提示词重排进输出；最终视频提示词仍按当前模板生成。",
      "如果当前文案与历史冲突，保留当前文案，并用自然方式解释承接。",
    ]),
  ].filter(Boolean).join("\n\n");
}

function buildDirectorContextTextV2(input: {
  userPreferences: JsonRecord;
  storyBible: JsonRecord;
  contextSummary: string | null;
  stateVector: JsonRecord;
  openLoops: string[];
  characterProfiles: Array<Record<string, unknown>>;
  storyLoops: Array<Record<string, unknown>>;
  recentEpisodes: Array<Record<string, unknown>>;
  relatedEpisodes: Array<Record<string, unknown>>;
  relatedMemories: Array<Record<string, unknown>>;
}) {
  const block = (title: string, lines: string[]) => {
    const body = lines.filter(Boolean).join("\n");
    return body ? `[${title}]\n${body}` : "";
  };
  const jsonLine = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return "";
    return `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`;
  };
  const preferenceLines = Object.entries(input.userPreferences).map(([key, value]) => jsonLine(key, value));
  const storyLines = Object.entries(input.storyBible).map(([key, value]) => jsonLine(key, value));
  const characterLines = input.characterProfiles.map((character) => [
    jsonLine("name", character.name),
    jsonLine("role", character.role),
    jsonLine("appearance", character.appearance),
    jsonLine("personality", character.personality),
    jsonLine("relationship", character.relationshipState),
    jsonLine("visualLock", character.visualLock),
  ].filter(Boolean).join("\n"));
  const loopLines = input.storyLoops.map((loop, index) => [
    `${index + 1}. ${loop.title || ""}`,
    jsonLine("description", loop.description),
    jsonLine("status", loop.status),
    jsonLine("importance", loop.importance),
  ].filter(Boolean).join("\n"));
  const recentLines = input.recentEpisodes.map((episode) => [
    `episode ${episode.versionNumber}: ${episode.episodeSummary || episode.title || ""}`,
    jsonLine("endingState", episode.endingState),
    jsonLine("characterState", episode.characterState),
  ].filter(Boolean).join("\n"));
  const relatedLines = input.relatedEpisodes.map((episode) => [
    `episode ${episode.versionNumber}: ${episode.episodeSummary || episode.title || ""}`,
    jsonLine("relatedEnding", episode.endingState),
    jsonLine("score", episode.relevanceScore),
  ].filter(Boolean).join("\n"));
  const stateLines = Object.entries(input.stateVector).map(([key, value]) => jsonLine(key, value));
  const openLoopLines = input.openLoops.map((loop, index) => `${index + 1}. ${loop}`);
  const memoryLines = input.relatedMemories.map((memory) => [
    `${memory.type || "MEMORY"}: ${memory.title || ""}`,
    memory.content ? String(memory.content) : "",
    jsonLine("score", memory.relevanceScore),
  ].filter(Boolean).join("\n"));

  return [
    block("L1 User Profile", preferenceLines),
    block("L2 Story Bible", [
      input.contextSummary ? `summary: ${input.contextSummary}` : "",
      ...storyLines,
    ]),
    block("L2 Character Profiles", characterLines),
    block("L3 Recent Episode Memory", recentLines),
    block("L3 Related Episode Memory", relatedLines),
    block("L3 State Vector", stateLines),
    block("L3 Open Loops", openLoopLines),
    block("L4 Story Loops", loopLines),
    block("L4 Top-K Retrieval Memory", memoryLines),
    block("L5 Working Rules", [
      "Use these records only to preserve continuity, character state, locations, props, tone, and visual style.",
      "The current user script has priority over history.",
      "Do not copy or reformat old fullVideoPrompt text into the new output.",
      "Keep the existing video prompt output template unchanged.",
      "If current input conflicts with memory, follow current input and bridge the conflict naturally.",
    ]),
  ].filter(Boolean).join("\n\n");
}

function mapProjectSummary(project: Pick<Project, "id" | "title" | "contentType" | "style" | "duration" | "status" | "createdAt">) {
  return {
    id: project.id,
    title: project.title,
    content_type: project.contentType,
    style: project.style,
    duration: project.duration,
    status: project.status,
    created_at: project.createdAt.toISOString(),
  };
}

function mapShotDetail(shot: {
  id: string;
  shotNumber: number;
  scene: string | null;
  visual: string | null;
  shotType: string | null;
  cameraMovement: string | null;
  emotion: string | null;
  transition: string | null;
  firstFramePrompt: string | null;
  videoPrompt: string | null;
  lastFramePrompt: string | null;
  negativePrompt: string | null;
}) {
  return {
    id: shot.id,
    shotNumber: shot.shotNumber,
    scene: shot.scene,
    visual: shot.visual,
    shotType: shot.shotType,
    cameraMovement: shot.cameraMovement,
    emotion: shot.emotion,
    transition: shot.transition,
    firstFramePrompt: shot.firstFramePrompt,
    videoPrompt: shot.videoPrompt,
    lastFramePrompt: shot.lastFramePrompt,
    negativePrompt: shot.negativePrompt,
  };
}

function mapVisualAssetDetail(asset: {
  id: string;
  projectId: string;
  versionId: string | null;
  shotId: string | null;
  shotNumber: number | null;
  entityId?: string | null;
  type: VisualAssetType;
  name: string;
  variantKey?: string | null;
  prompt: string | null;
  imageUrl: string | null;
  status: VisualAssetStatus;
  error: string | null;
  isPrimary?: boolean;
  locked?: boolean;
  referenceWeight?: number;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: asset.id,
    projectId: asset.projectId,
    versionId: asset.versionId,
    shotId: asset.shotId,
    shotNumber: asset.shotNumber,
    entityId: asset.entityId || null,
    type: asset.type,
    name: asset.name,
    variantKey: asset.variantKey || null,
    prompt: asset.prompt,
    imageUrl: asset.imageUrl,
    status: asset.status,
    error: asset.error,
    isPrimary: Boolean(asset.isPrimary),
    locked: Boolean(asset.locked),
    referenceWeight: asset.referenceWeight ?? 1,
    metadata: asset.metadata,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

function mapProjectVisualEntityDetail(entity: {
  id: string;
  projectId: string;
  type: VisualEntityType;
  key: string;
  name: string;
  aliases: string[];
  canonicalPrompt: string | null;
  visualLock: string | null;
  negativeLock: string | null;
  status: VisualEntityStatus;
  primaryAssetId: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: entity.id,
    projectId: entity.projectId,
    type: entity.type,
    key: entity.key,
    name: entity.name,
    aliases: entity.aliases,
    canonicalPrompt: entity.canonicalPrompt,
    visualLock: entity.visualLock,
    negativeLock: entity.negativeLock,
    status: entity.status,
    primaryAssetId: entity.primaryAssetId,
    metadata: entity.metadata,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

function mapShotVisualReferenceDetail(reference: {
  id: string;
  projectId: string;
  versionId: string;
  shotId: string;
  entityId: string;
  role: ShotVisualReferenceRole;
  order: number;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: reference.id,
    projectId: reference.projectId,
    versionId: reference.versionId,
    shotId: reference.shotId,
    entityId: reference.entityId,
    role: reference.role,
    order: reference.order,
    metadata: reference.metadata,
    createdAt: reference.createdAt.toISOString(),
    updatedAt: reference.updatedAt.toISOString(),
  };
}

async function upsertCharacterProfiles(
  prisma: Prisma.TransactionClient,
  options: {
    userId: string;
    projectId: string;
    versionId: string;
    characters: ReturnType<typeof deriveCharacterProfiles>;
  },
) {
  for (const character of options.characters) {
    if (!character.name) continue;
    await prisma.characterProfile.upsert({
      where: {
        projectId_name: {
          projectId: options.projectId,
          name: character.name,
        },
      },
      create: {
        userId: options.userId,
        projectId: options.projectId,
        name: character.name,
        aliases: character.aliases,
        role: character.role,
        appearance: character.appearance,
        personality: character.personality,
        relationshipState: character.relationshipState,
        visualLock: character.visualLock,
        referenceImageUrl: character.referenceImageUrl,
        importance: character.importance,
        locked: character.locked,
        firstSeenVersionId: options.versionId,
        lastSeenVersionId: options.versionId,
        metadata: toJson(character.metadata),
      },
      update: {
        aliases: character.aliases,
        role: character.role,
        appearance: character.appearance,
        personality: character.personality,
        relationshipState: character.relationshipState,
        visualLock: character.visualLock,
        referenceImageUrl: character.referenceImageUrl,
        importance: character.importance,
        locked: character.locked,
        lastSeenVersionId: options.versionId,
        metadata: toJson(character.metadata),
      },
    });
  }
}

async function upsertStoryLoops(
  prisma: Prisma.TransactionClient,
  options: {
    userId: string;
    projectId: string;
    versionId: string;
    loops: ReturnType<typeof deriveStoryLoops>;
  },
) {
  for (const loop of options.loops.openLoops) {
    if (!loop.title) continue;
    await prisma.storyLoop.upsert({
      where: {
        projectId_title: {
          projectId: options.projectId,
          title: loop.title,
        },
      },
      create: {
        userId: options.userId,
        projectId: options.projectId,
        createdVersionId: options.versionId,
        title: loop.title,
        description: loop.description,
        status: StoryLoopStatus.OPEN,
        importance: loop.importance,
        evidence: toJson(loop.evidence),
        metadata: toJson(loop.metadata),
      },
      update: {
        description: loop.description,
        status: StoryLoopStatus.OPEN,
        importance: loop.importance,
        evidence: toJson(loop.evidence),
        metadata: toJson(loop.metadata),
      },
    });
  }

  for (const loop of options.loops.resolvedLoops) {
    await prisma.storyLoop.updateMany({
      where: {
        projectId: options.projectId,
        title: loop.title,
      },
      data: {
        status: StoryLoopStatus.RESOLVED,
        resolvedVersionId: options.versionId,
      },
    });
  }
}

async function upsertProjectVisualEntities(
  prisma: Prisma.TransactionClient,
  options: {
    userId: string;
    projectId: string;
    visualEntities: ProjectVisualEntityInput[];
  },
) {
  const visualEntities = Array.isArray(options.visualEntities) ? options.visualEntities.slice(0, 80) : [];
  if (!visualEntities.length) return [];

  const project = await prisma.project.findFirst({
    where: { id: options.projectId, userId: options.userId },
    select: { id: true },
  });
  if (!project) throw new BadRequestException("Project not found");

  const savedEntities = [];
  for (const entity of visualEntities) {
    const type = entity.type && entity.type in VisualEntityType
      ? VisualEntityType[entity.type as keyof typeof VisualEntityType]
      : undefined;
    if (!type) throw new BadRequestException("Unsupported visual entity type");

    const status = entity.status && entity.status in VisualEntityStatus
      ? VisualEntityStatus[entity.status as keyof typeof VisualEntityStatus]
      : VisualEntityStatus.CANDIDATE;
    const name = cleanText(entity.name, 160);
    if (!name) throw new BadRequestException("Visual entity name is required");
    const key = visualEntityKey(entity.key, name);
    const primaryAssetId = entity.primaryAssetId
      ? await prisma.visualAsset.findFirst({
        where: { id: entity.primaryAssetId, projectId: options.projectId, userId: options.userId },
        select: { id: true },
      }).then((asset) => asset?.id || null)
      : null;
    const aliases = Array.isArray(entity.aliases)
      ? entity.aliases.map((alias) => cleanText(alias, 80)).filter(Boolean) as string[]
      : [];

    const savedEntity = await prisma.projectVisualEntity.upsert({
      where: { projectId_key: { projectId: options.projectId, key } },
      create: {
        userId: options.userId,
        projectId: options.projectId,
        type,
        key,
        name,
        aliases,
        canonicalPrompt: cleanText(entity.canonicalPrompt, 5000),
        visualLock: cleanText(entity.visualLock, 5000),
        negativeLock: cleanText(entity.negativeLock, 5000),
        status,
        primaryAssetId,
        metadata: toJson(entity.metadata),
      },
      update: {
        type,
        name,
        aliases,
        canonicalPrompt: cleanText(entity.canonicalPrompt, 5000),
        visualLock: cleanText(entity.visualLock, 5000),
        negativeLock: cleanText(entity.negativeLock, 5000),
        status,
        primaryAssetId,
        metadata: toJson(entity.metadata),
      },
      select: {
        id: true,
        projectId: true,
        type: true,
        key: true,
        name: true,
        aliases: true,
        canonicalPrompt: true,
        visualLock: true,
        negativeLock: true,
        status: true,
        primaryAssetId: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    savedEntities.push(savedEntity);
  }

  return savedEntities.map(mapProjectVisualEntityDetail);
}

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  private async findVectorRelatedMemories(userId: string, projectId: string, currentScript: string) {
    const queryVector = formatPgVector(buildLocalEmbedding(currentScript));
    try {
      const rows = await this.prisma.$queryRawUnsafe<MemoryVectorRow[]>(
        `SELECT
          "id",
          "type",
          "title",
          "content",
          "keywords",
          "importance",
          "recency",
          "metadata",
          "createdAt",
          GREATEST(0, 1 - ("embeddingVector" <=> $1::vector)) AS "semanticScore"
        FROM "MemoryItem"
        WHERE "userId" = $2
          AND "projectId" = $3
          AND "isEnabled" = true
          AND "embeddingVector" IS NOT NULL
        ORDER BY "embeddingVector" <=> $1::vector ASC
        LIMIT $4`,
        queryVector,
        userId,
        projectId,
        MEMORY_RETRIEVAL_LIMIT,
      );

      return rows.map((memory, index) => {
        const semanticScore = clamp01(memory.semanticScore, 0);
        return {
          id: memory.id,
          type: memory.type,
          title: memory.title,
          content: memory.content,
          keywords: memory.keywords,
          importance: memory.importance,
          recency: memory.recency,
          relevanceScore: memory.importance * 0.5 + semanticScore * 0.4 + memory.recency * 0.1,
          retrievalSource: "pgvector",
          retrievalRank: index + 1,
          createdAt: memory.createdAt.toISOString(),
        };
      });
    } catch {
      return [];
    }
  }

  async listProjects(userId: string) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const projects = await this.prisma.project.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        contentType: true,
        style: true,
        duration: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return projects.map(mapProjectSummary);
  }

  async getProject(userId: string, projectId: string) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: {
        id: true,
        title: true,
        originalScript: true,
        optimizedScript: true,
        contentType: true,
        style: true,
        duration: true,
        status: true,
        storyBible: true,
        contextSummary: true,
        stateVector: true,
        openLoops: true,
        createdAt: true,
        updatedAt: true,
        characterProfiles: {
          orderBy: { importance: "desc" },
          select: {
            id: true,
            name: true,
            aliases: true,
            role: true,
            appearance: true,
            personality: true,
            relationshipState: true,
            visualLock: true,
            referenceImageUrl: true,
            importance: true,
            locked: true,
            updatedAt: true,
          },
        },
        storyLoops: {
          orderBy: [{ status: "asc" }, { importance: "desc" }],
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            importance: true,
            evidence: true,
            updatedAt: true,
          },
        },
        memoryItems: {
          orderBy: { createdAt: "desc" },
          take: 80,
          select: {
            id: true,
            type: true,
            title: true,
            content: true,
            keywords: true,
            importance: true,
            recency: true,
            isEnabled: true,
            source: true,
            createdAt: true,
          },
        },
        visualEntities: {
          orderBy: [{ type: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            projectId: true,
            type: true,
            key: true,
            name: true,
            aliases: true,
            canonicalPrompt: true,
            visualLock: true,
            negativeLock: true,
            status: true,
            primaryAssetId: true,
            metadata: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        versions: {
          orderBy: { versionNumber: "desc" },
          select: {
            id: true,
            versionNumber: true,
            title: true,
            originalScript: true,
            optimizedScript: true,
            contentType: true,
            style: true,
            duration: true,
            status: true,
            storyboardImageUrl: true,
            storyboardImagePrompt: true,
            fullVideoPrompt: true,
            episodeSummary: true,
            endingState: true,
            characterState: true,
            memoryJson: true,
            contextSnapshot: true,
            stateVector: true,
            openLoops: true,
            qualityCheck: true,
            createdAt: true,
            shots: {
              orderBy: { shotNumber: "asc" },
              select: {
                id: true,
                shotNumber: true,
                scene: true,
                visual: true,
                shotType: true,
                cameraMovement: true,
                emotion: true,
                transition: true,
                firstFramePrompt: true,
                videoPrompt: true,
                lastFramePrompt: true,
                negativePrompt: true,
              },
            },
            visualAssets: {
              orderBy: [{ shotNumber: "asc" }, { createdAt: "asc" }],
              select: {
                id: true,
                projectId: true,
                versionId: true,
                shotId: true,
                shotNumber: true,
                entityId: true,
                type: true,
                name: true,
                variantKey: true,
                prompt: true,
                imageUrl: true,
                status: true,
                error: true,
                isPrimary: true,
                locked: true,
                referenceWeight: true,
                metadata: true,
                createdAt: true,
                updatedAt: true,
              },
            },
            shotVisualReferences: {
              orderBy: [{ order: "asc" }, { createdAt: "asc" }],
              select: {
                id: true,
                projectId: true,
                versionId: true,
                shotId: true,
                entityId: true,
                role: true,
                order: true,
                metadata: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });

    if (!project) throw new BadRequestException("Project not found");

    return {
      id: project.id,
      title: project.title,
      originalScript: project.originalScript,
      optimizedScript: project.optimizedScript,
      contentType: project.contentType,
      style: project.style,
      duration: project.duration,
      status: project.status,
      storyBible: project.storyBible,
      contextSummary: project.contextSummary,
      stateVector: project.stateVector,
      openLoops: project.openLoops,
      characterProfiles: project.characterProfiles.map((character) => ({
        id: character.id,
        name: character.name,
        aliases: character.aliases,
        role: character.role,
        appearance: character.appearance,
        personality: character.personality,
        relationshipState: character.relationshipState,
        visualLock: character.visualLock,
        referenceImageUrl: character.referenceImageUrl,
        importance: character.importance,
        locked: character.locked,
        updatedAt: character.updatedAt.toISOString(),
      })),
      storyLoops: project.storyLoops.map((loop) => ({
        id: loop.id,
        title: loop.title,
        description: loop.description,
        status: loop.status,
        importance: loop.importance,
        evidence: loop.evidence,
        updatedAt: loop.updatedAt.toISOString(),
      })),
      memoryItems: project.memoryItems.map((memory) => ({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        keywords: memory.keywords,
        importance: memory.importance,
        recency: memory.recency,
        isEnabled: memory.isEnabled,
        source: memory.source,
        createdAt: memory.createdAt.toISOString(),
      })),
      visualEntities: project.visualEntities.map(mapProjectVisualEntityDetail),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      versions: project.versions.map((version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        title: version.title,
        originalScript: version.originalScript,
        optimizedScript: version.optimizedScript,
        contentType: version.contentType,
        style: version.style,
        duration: version.duration,
        status: version.status,
        storyboardImageUrl: version.storyboardImageUrl,
        storyboardImagePrompt: version.storyboardImagePrompt,
        fullVideoPrompt: version.fullVideoPrompt,
        episodeSummary: version.episodeSummary,
        endingState: version.endingState,
        characterState: version.characterState,
        memoryJson: version.memoryJson,
        contextSnapshot: version.contextSnapshot,
        stateVector: version.stateVector,
        openLoops: version.openLoops,
        qualityCheck: version.qualityCheck,
        createdAt: version.createdAt.toISOString(),
        shots: version.shots.map(mapShotDetail),
        visualAssets: version.visualAssets.map(mapVisualAssetDetail),
        shotVisualReferences: version.shotVisualReferences.map(mapShotVisualReferenceDetail),
      })),
    };
  }

  async deleteProject(userId: string, projectId: string) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const result = await this.prisma.project.deleteMany({
      where: { id: projectId, userId },
    });

    if (result.count === 0) throw new BadRequestException("Project not found");

    return { deleted: true, projectId };
  }

  async deleteProjectVersion(userId: string, projectId: string, versionId: string) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const result = await this.prisma.$transaction(async (prisma) => {
      const version = await prisma.projectVersion.findFirst({
        where: { id: versionId, projectId, project: { userId } },
        select: { id: true, versionNumber: true },
      });

      if (!version) throw new BadRequestException("Project version not found");

      await prisma.projectVersion.delete({ where: { id: version.id } });
      const laterVersions = await prisma.projectVersion.findMany({
        where: { projectId, versionNumber: { gt: version.versionNumber } },
        orderBy: { versionNumber: "asc" },
        select: { id: true },
      });

      for (const laterVersion of laterVersions) {
        await prisma.projectVersion.update({
          where: { id: laterVersion.id },
          data: { versionNumber: { decrement: 1 } },
        });
      }

      return { versionNumber: version.versionNumber };
    });

    return { deleted: true, projectId, versionId, versionNumber: result.versionNumber };
  }

  async buildGenerationContext(userId: string, projectId: string, currentScript: string) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: {
        id: true,
        title: true,
        storyBible: true,
        contextSummary: true,
        stateVector: true,
        openLoops: true,
        characterProfiles: {
          orderBy: { importance: "desc" },
          take: 12,
          select: {
            id: true,
            name: true,
            aliases: true,
            role: true,
            appearance: true,
            personality: true,
            relationshipState: true,
            visualLock: true,
            importance: true,
            locked: true,
          },
        },
        storyLoops: {
          where: { status: StoryLoopStatus.OPEN },
          orderBy: { importance: "desc" },
          take: 12,
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            importance: true,
          },
        },
        user: {
          select: {
            promptPreferences: true,
          },
        },
        versions: {
          orderBy: { versionNumber: "desc" },
          select: {
            id: true,
            versionNumber: true,
            title: true,
            originalScript: true,
            episodeSummary: true,
            endingState: true,
            characterState: true,
            memoryJson: true,
            stateVector: true,
            openLoops: true,
            createdAt: true,
          },
        },
      },
    });

    if (!project) throw new BadRequestException("Project not found");

    const memoryItems = await this.prisma.memoryItem.findMany({
      where: { projectId: project.id, userId, isEnabled: true },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        keywords: true,
        importance: true,
        recency: true,
        metadata: true,
        embedding: true,
        createdAt: true,
      },
    });

    const recentEpisodes = project.versions.slice(0, 3).map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      title: version.title,
      episodeSummary: version.episodeSummary,
      endingState: version.endingState,
      characterState: version.characterState,
      memoryJson: version.memoryJson,
      createdAt: version.createdAt.toISOString(),
    }));
    const recentIds = new Set(recentEpisodes.map((episode) => episode.id));
    const relatedEpisodes = project.versions
      .filter((version) => !recentIds.has(version.id))
      .map((version) => ({ version, score: scoreEpisodeMemory(version, currentScript) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ version, score }) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        title: version.title,
        episodeSummary: version.episodeSummary,
        endingState: version.endingState,
        characterState: version.characterState,
        memoryJson: version.memoryJson,
        relevanceScore: score,
        createdAt: version.createdAt.toISOString(),
      }));
    const vectorRelatedMemories = await this.findVectorRelatedMemories(userId, project.id, currentScript);
    const localRelatedMemories = memoryItems
      .map((memory, index) => ({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        keywords: memory.keywords,
        importance: memory.importance,
        recency: memory.recency,
        relevanceScore: scoreMemoryItem(memory, currentScript, index),
        retrievalSource: "local",
        retrievalRank: index + 1,
        createdAt: memory.createdAt.toISOString(),
      }))
      .filter((memory) => memory.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, MEMORY_RETRIEVAL_LIMIT);
    const relatedMemories = vectorRelatedMemories.length ? vectorRelatedMemories : localRelatedMemories;

    const userPreferences = {
      ...DEFAULT_PROMPT_PREFERENCES,
      ...pickRecord(project.user.promptPreferences),
    };
    const storyBible = pickRecord(project.storyBible);
    const stateVector = pickRecord(project.stateVector);
    const openLoops = asStringArray(project.openLoops, 20);
    const contextText = buildDirectorContextTextV2({
      userPreferences,
      storyBible,
      contextSummary: project.contextSummary,
      stateVector,
      openLoops,
      characterProfiles: project.characterProfiles,
      storyLoops: project.storyLoops,
      recentEpisodes,
      relatedEpisodes,
      relatedMemories,
    });

    return {
      projectId: project.id,
      title: project.title,
      userPreferences,
      storyBible,
      contextSummary: project.contextSummary,
      stateVector,
      openLoops,
      characterProfiles: project.characterProfiles,
      storyLoops: project.storyLoops,
      recentEpisodes,
      relatedEpisodes,
      relatedMemories,
      contextText,
    };
  }

  async createProject(userId: string, input: CreateProjectDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");
    const episodeMemory = deriveEpisodeMemory(input);
    const narrativeMemory = deriveNarrativeMemory(input, episodeMemory);
    const qualityCheck = deriveQualityCheck(input, narrativeMemory);

    const result = await this.prisma.$transaction(async (prisma) => {
      const project = input.projectId
        ? await prisma.project.findFirst({
            where: { id: input.projectId, userId },
            select: { id: true, storyBible: true, stateVector: true, openLoops: true },
          })
        : await prisma.project.create({
            data: {
              userId,
              title: input.title,
              originalScript: input.originalScript,
              optimizedScript: input.optimizedScript,
              contentType: input.contentType,
              style: input.style,
              duration: input.duration,
              status: input.status || "draft",
            },
            select: { id: true, storyBible: true, stateVector: true, openLoops: true },
          });
      if (!project) throw new BadRequestException("Project not found");
      const storyBible = mergeStoryBible(project.storyBible, input, episodeMemory);
      const characterProfiles = deriveCharacterProfiles(input, narrativeMemory);
      const storyLoops = deriveStoryLoops(input, narrativeMemory);
      const visualEntities = deriveProjectVisualEntities(input, narrativeMemory, episodeMemory);
      storyBible.characters = appendUnique(storyBible.characters, characterProfiles.map((character) => character.name), 50);
      storyBible.openLoops = narrativeMemory.openLoops;
      const contextSummary = cleanText(input.contextSummary, 500) || buildContextSummary(storyBible, episodeMemory);
      const stateVector = pickRecord(narrativeMemory.stateVector);
      const openLoops = asStringArray(narrativeMemory.openLoops, 20);
      const contextSnapshot = {
        storyBible,
        narrativeMemory,
        stateVector,
        openLoops,
        qualityCheck,
        priorContext: input.contextSnapshot || null,
      };

      if (input.versionId) {
        const ownedVersion = await prisma.projectVersion.findFirst({
          where: { id: input.versionId, projectId: project.id, project: { userId } },
          select: { id: true, versionNumber: true },
        });
        if (!ownedVersion) throw new BadRequestException("Project version not found");

        await prisma.storyboardShot.deleteMany({ where: { versionId: input.versionId } });

        const version = await prisma.projectVersion.update({
          where: { id: ownedVersion.id },
          data: {
            title: input.title,
            originalScript: input.originalScript,
            optimizedScript: input.optimizedScript,
            contentType: input.contentType,
            style: input.style,
            duration: input.duration,
            status: input.status || "draft",
            storyboardImageUrl: input.storyboardImageUrl,
            storyboardImagePrompt: input.storyboardImagePrompt,
            fullVideoPrompt: input.fullVideoPrompt,
            episodeSummary: episodeMemory.episodeSummary,
            endingState: episodeMemory.endingState,
            characterState: episodeMemory.characterState,
            memoryJson: toJson(episodeMemory.memoryJson),
            contextSnapshot: toJson(contextSnapshot),
            stateVector: toJson(stateVector),
            openLoops: toJson(openLoops),
            qualityCheck: toJson(qualityCheck),
            shots: {
              create: input.shots.map((shot) => ({
                projectId: project.id,
                shotNumber: shot.shotNumber,
                scene: shot.scene,
                visual: shot.visual,
                shotType: shot.shotType,
                cameraMovement: shot.cameraMovement,
                emotion: shot.emotion,
                transition: shot.transition,
                firstFramePrompt: shot.firstFramePrompt,
                videoPrompt: shot.videoPrompt,
                lastFramePrompt: shot.lastFramePrompt,
                negativePrompt: shot.negativePrompt,
              })),
            },
          },
          select: { id: true },
        });

        await prisma.memoryItem.deleteMany({ where: { versionId: version.id } });
        const memoryItems = deriveMemoryItems(input, episodeMemory, project.id, userId, version.id);
        if (memoryItems.length) {
          await prisma.memoryItem.createMany({ data: memoryItems });
        }
        await upsertCharacterProfiles(prisma, { userId, projectId: project.id, versionId: version.id, characters: characterProfiles });
        await upsertProjectVisualEntities(prisma, { userId, projectId: project.id, visualEntities });
        await upsertStoryLoops(prisma, { userId, projectId: project.id, versionId: version.id, loops: storyLoops });

        await prisma.project.update({
          where: { id: project.id },
          data: {
            storyBible: toJson(storyBible),
            contextSummary,
            stateVector: toJson(stateVector),
            openLoops: toJson(openLoops),
          },
        });

        return { project, version, versionNumber: ownedVersion.versionNumber };
      }

      const latestVersion = await prisma.projectVersion.findFirst({
        where: { projectId: project.id },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const versionNumber = latestVersion ? latestVersion.versionNumber + 1 : 1;

      const version = await prisma.projectVersion.create({
        data: {
          projectId: project.id,
          versionNumber,
          title: input.title,
          originalScript: input.originalScript,
          optimizedScript: input.optimizedScript,
          contentType: input.contentType,
          style: input.style,
          duration: input.duration,
          status: input.status || "draft",
          storyboardImageUrl: input.storyboardImageUrl,
          storyboardImagePrompt: input.storyboardImagePrompt,
          fullVideoPrompt: input.fullVideoPrompt,
          episodeSummary: episodeMemory.episodeSummary,
          endingState: episodeMemory.endingState,
          characterState: episodeMemory.characterState,
          memoryJson: toJson(episodeMemory.memoryJson),
          contextSnapshot: toJson(contextSnapshot),
          stateVector: toJson(stateVector),
          openLoops: toJson(openLoops),
          qualityCheck: toJson(qualityCheck),
          shots: {
            create: input.shots.map((shot) => ({
              projectId: project.id,
              shotNumber: shot.shotNumber,
              scene: shot.scene,
              visual: shot.visual,
              shotType: shot.shotType,
              cameraMovement: shot.cameraMovement,
              emotion: shot.emotion,
              transition: shot.transition,
              firstFramePrompt: shot.firstFramePrompt,
              videoPrompt: shot.videoPrompt,
              lastFramePrompt: shot.lastFramePrompt,
              negativePrompt: shot.negativePrompt,
            })),
          },
        },
        select: { id: true },
      });

      await prisma.memoryItem.deleteMany({ where: { versionId: version.id } });
      const memoryItems = deriveMemoryItems(input, episodeMemory, project.id, userId, version.id);
      if (memoryItems.length) {
        await prisma.memoryItem.createMany({ data: memoryItems });
      }
      await upsertCharacterProfiles(prisma, { userId, projectId: project.id, versionId: version.id, characters: characterProfiles });
      await upsertProjectVisualEntities(prisma, { userId, projectId: project.id, visualEntities });
      await upsertStoryLoops(prisma, { userId, projectId: project.id, versionId: version.id, loops: storyLoops });

      await prisma.project.update({
        where: { id: project.id },
        data: {
          storyBible: toJson(storyBible),
          contextSummary,
          stateVector: toJson(stateVector),
          openLoops: toJson(openLoops),
        },
      });

      return { project, version, versionNumber };
    });

    await syncMemoryEmbeddingVectors(this.prisma, result.version.id);

    return { saved: true, projectId: result.project.id, versionId: result.version.id, versionNumber: result.versionNumber };
  }

  async updateProjectMemory(userId: string, projectId: string, input: UpdateProjectMemoryDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const project = await this.prisma.project.update({
      where: { id: projectId, userId },
      data: {
        storyBible: input.storyBible === undefined ? undefined : toJson(input.storyBible),
        contextSummary: input.contextSummary,
        stateVector: input.stateVector === undefined ? undefined : toJson(input.stateVector),
        openLoops: input.openLoops === undefined ? undefined : toJson(input.openLoops),
      },
      select: {
        id: true,
        storyBible: true,
        contextSummary: true,
        stateVector: true,
        openLoops: true,
      },
    });

    return { saved: true, project };
  }

  async updateCharacterProfile(userId: string, projectId: string, characterId: string, input: UpdateCharacterProfileDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const character = await this.prisma.characterProfile.update({
      where: {
        id: characterId,
        projectId,
        userId,
      },
      data: {
        role: input.role,
        appearance: input.appearance,
        personality: input.personality,
        relationshipState: input.relationshipState,
        visualLock: input.visualLock,
        locked: input.locked,
      },
    });

    return { saved: true, character };
  }

  async updateStoryLoop(userId: string, projectId: string, loopId: string, input: UpdateStoryLoopDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");
    const status = input.status && input.status in StoryLoopStatus
      ? StoryLoopStatus[input.status as keyof typeof StoryLoopStatus]
      : undefined;

    const loop = await this.prisma.storyLoop.update({
      where: {
        id: loopId,
        projectId,
        userId,
      },
      data: {
        description: input.description,
        status,
      },
    });

    return { saved: true, loop };
  }

  async updateMemoryItem(userId: string, projectId: string, memoryId: string, input: UpdateMemoryItemDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const content = input.content === undefined ? undefined : cleanText(input.content, 1200);
    const memory = await this.prisma.memoryItem.update({
      where: {
        id: memoryId,
        projectId,
        userId,
      },
      data: {
        content,
        isEnabled: input.isEnabled,
        embedding: content ? toJson(buildLocalEmbedding(content)) : undefined,
      },
    });

    if (content) {
      try {
        await this.prisma.$executeRawUnsafe(
          'UPDATE "MemoryItem" SET "embeddingVector" = $1::vector WHERE "id" = $2',
          formatPgVector(buildLocalEmbedding(content)),
          memory.id,
        );
      } catch {
        // pgvector is optional; keep the JSON embedding as the fallback.
      }
    }

    return { saved: true, memory };
  }

  async saveStoryboardImage(userId: string, projectId: string, versionId: string, input: SaveStoryboardImageDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const ownedVersion = await this.prisma.projectVersion.findFirst({
      where: {
        id: versionId,
        projectId,
        project: { userId },
      },
      select: { id: true },
    });
    if (!ownedVersion) throw new BadRequestException("Project version not found");

    const version = await this.prisma.projectVersion.update({
      where: { id: ownedVersion.id },
      data: {
        storyboardImageUrl: input.storyboardImageUrl,
        storyboardImagePrompt: input.storyboardImagePrompt,
      },
      select: {
        id: true,
        projectId: true,
        versionNumber: true,
        storyboardImageUrl: true,
      },
    });

    return {
      saved: true,
      projectId: version.projectId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      storyboardImageUrl: version.storyboardImageUrl,
    };
  }

  async upsertVisualAssets(userId: string, projectId: string, versionId: string, input: SaveVisualAssetsDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");
    const visualAssets = Array.isArray(input.visualAssets) ? input.visualAssets.slice(0, 80) : [];
    if (!visualAssets.length) return [];

    return this.prisma.$transaction(async (prisma) => {
      const version = await prisma.projectVersion.findFirst({
        where: {
          id: versionId,
          projectId,
          project: { userId },
        },
        select: {
          id: true,
          projectId: true,
          shots: {
            select: {
              id: true,
              shotNumber: true,
            },
          },
        },
      });
      if (!version) throw new BadRequestException("Project version not found");

      const shotByNumber = new Map(version.shots.map((shot) => [shot.shotNumber, shot.id]));
      const shotById = new Map(version.shots.map((shot) => [shot.id, shot.shotNumber]));
      const savedAssets = [];

      for (const asset of visualAssets) {
        const type = asset.type && asset.type in VisualAssetType
          ? VisualAssetType[asset.type as keyof typeof VisualAssetType]
          : undefined;
        if (!type) throw new BadRequestException("Unsupported visual asset type");

        const status = asset.status && asset.status in VisualAssetStatus
          ? VisualAssetStatus[asset.status as keyof typeof VisualAssetStatus]
          : VisualAssetStatus.COMPLETED;
        const shotId = asset.shotId && shotById.has(asset.shotId)
          ? asset.shotId
          : asset.shotNumber !== undefined
            ? shotByNumber.get(asset.shotNumber) || null
            : null;
        const shotNumber = asset.shotNumber !== undefined
          ? asset.shotNumber
          : shotId
            ? shotById.get(shotId) || null
            : null;
        const entityId = asset.entityId
          ? await prisma.projectVisualEntity.findFirst({
            where: { id: asset.entityId, projectId, userId },
            select: { id: true },
          }).then((entity) => entity?.id || null)
          : null;
        const name = cleanText(asset.name, 160) || (type === VisualAssetType.SHOT_STORYBOARD ? "镜头分镜图" : "视觉资产");

        await prisma.visualAsset.deleteMany({
          where: {
            userId,
            projectId,
            versionId: version.id,
            type,
            name,
            shotNumber,
            entityId,
          },
        });

        const savedAsset = await prisma.visualAsset.create({
          data: {
            userId,
            projectId,
            versionId: version.id,
            shotId,
            shotNumber,
            entityId,
            type,
            name,
            variantKey: cleanText(asset.variantKey, 120),
            prompt: cleanText(asset.prompt, 5000),
            imageUrl: cleanText(asset.imageUrl, 1200),
            status,
            error: cleanText(asset.error, 1200),
            isPrimary: Boolean(asset.isPrimary),
            locked: Boolean(asset.locked),
            referenceWeight: typeof asset.referenceWeight === "number" ? asset.referenceWeight : 1,
            metadata: toJson(asset.metadata),
          },
          select: {
            id: true,
            projectId: true,
            versionId: true,
            shotId: true,
            shotNumber: true,
            entityId: true,
            type: true,
            name: true,
            variantKey: true,
            prompt: true,
            imageUrl: true,
            status: true,
            error: true,
            isPrimary: true,
            locked: true,
            referenceWeight: true,
            metadata: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        savedAssets.push(savedAsset);
      }

      return savedAssets.map(mapVisualAssetDetail);
    });
  }

  async upsertProjectVisualEntities(userId: string, projectId: string, input: SaveProjectVisualEntitiesDto) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");
    return upsertProjectVisualEntities(this.prisma, {
      userId,
      projectId,
      visualEntities: input.visualEntities || [],
    });
  }

  async upsertShotVisualReferences(
    userId: string,
    projectId: string,
    versionId: string,
    input: SaveShotVisualReferencesDto,
  ) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");
    const visualReferences = Array.isArray(input.visualReferences) ? input.visualReferences.slice(0, 160) : [];
    if (!visualReferences.length) return [];

    return this.prisma.$transaction(async (prisma) => {
      const version = await prisma.projectVersion.findFirst({
        where: {
          id: versionId,
          projectId,
          project: { userId },
        },
        select: {
          id: true,
          shots: { select: { id: true, shotNumber: true } },
        },
      });
      if (!version) throw new BadRequestException("Project version not found");

      const shotByNumber = new Map(version.shots.map((shot) => [shot.shotNumber, shot.id]));
      const shotIds = new Set(version.shots.map((shot) => shot.id));
      const savedReferences = [];

      for (const reference of visualReferences) {
        const shotId = reference.shotId && shotIds.has(reference.shotId)
          ? reference.shotId
          : reference.shotNumber !== undefined
            ? shotByNumber.get(reference.shotNumber) || null
            : null;
        if (!shotId) throw new BadRequestException("Referenced shot was not found in this version");

        const entity = await prisma.projectVisualEntity.findFirst({
          where: { id: reference.entityId, projectId, userId },
          select: { id: true },
        });
        if (!entity) throw new BadRequestException("Referenced visual entity was not found in this project");

        const role = reference.role && reference.role in ShotVisualReferenceRole
          ? ShotVisualReferenceRole[reference.role as keyof typeof ShotVisualReferenceRole]
          : ShotVisualReferenceRole.SUBJECT;

        await prisma.shotVisualReference.deleteMany({
          where: {
            shotId,
            entityId: entity.id,
            role,
          },
        });

        const savedReference = await prisma.shotVisualReference.create({
          data: {
            userId,
            projectId,
            versionId,
            shotId,
            entityId: entity.id,
            role,
            order: typeof reference.order === "number" ? reference.order : 0,
            metadata: toJson(reference.metadata),
          },
          select: {
            id: true,
            projectId: true,
            versionId: true,
            shotId: true,
            entityId: true,
            role: true,
            order: true,
            metadata: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        savedReferences.push(savedReference);
      }

      return savedReferences.map(mapShotVisualReferenceDetail);
    });
  }

  async saveVisualAssets(userId: string, projectId: string, versionId: string, input: SaveVisualAssetsDto) {
    const visualAssets = await this.upsertVisualAssets(userId, projectId, versionId, input);
    return {
      saved: true,
      projectId,
      versionId,
      visualAssets,
    };
  }

  async saveProjectVisualEntities(userId: string, projectId: string, input: SaveProjectVisualEntitiesDto) {
    const visualEntities = await this.upsertProjectVisualEntities(userId, projectId, input);
    return {
      saved: true,
      projectId,
      visualEntities,
    };
  }

  async saveShotVisualReferences(
    userId: string,
    projectId: string,
    versionId: string,
    input: SaveShotVisualReferencesDto,
  ) {
    const visualReferences = await this.upsertShotVisualReferences(userId, projectId, versionId, input);
    return {
      saved: true,
      projectId,
      versionId,
      visualReferences,
    };
  }
}
