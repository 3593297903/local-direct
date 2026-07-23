import type { SegmentContract } from "./batch-segment-contract";

export type RenderScheduleProfile = "FAST" | "BALANCED" | "STRICT" | "SINGLE";

export type RenderScheduleSegment = {
  sourceText?: string;
  shotCount?: number;
  segmentContract?: Partial<SegmentContract> | null;
};

export type RenderPackSchedule<T> = {
  profile: RenderScheduleProfile;
  concurrency: number;
  packSize: number;
  riskScore: number;
  reasons: string[];
  packs: T[][];
};

type BuildRenderPackOptions<T> = {
  forceProfile?: RenderScheduleProfile;
  getSegment?: (item: T) => RenderScheduleSegment;
};

const profileSettings: Record<RenderScheduleProfile, { concurrency: number; packSize: number }> = {
  FAST: { concurrency: 4, packSize: 5 },
  BALANCED: { concurrency: 4, packSize: 4 },
  STRICT: { concurrency: 4, packSize: 3 },
  SINGLE: { concurrency: 4, packSize: 1 },
};

const sensitivePattern =
  /刑侦|公安|警察|警方|警局|尸体|尸|血|杀|凶手|暴力|未成年|政治|政府|国徽|警徽|自杀|伤口|肢体|犯罪|命案|尸检|强奸|性侵/;

export function scoreSegmentRisk(segment: RenderScheduleSegment) {
  const contract = segment.segmentContract || {};
  const text = [
    segment.sourceText,
    contract.sourceText,
    contract.title,
    ...(contract.requiredEvents || []),
    ...(contract.forbiddenFutureEvents || []),
  ]
    .filter(Boolean)
    .join("\n");
  const shotCount = Number(contract.shotCount || segment.shotCount || 0);
  const characters = contract.characters || [];
  const locations = contract.locations || [];
  const props = contract.props || [];
  const requiredEvents = contract.requiredEvents || [];
  const forbiddenFutureEvents = contract.forbiddenFutureEvents || [];
  const requiredShotBeats = contract.requiredShotBeats || [];
  const consistencyItems = characters.length + locations.length + props.length;

  let score = 0;
  const reasons: string[] = [];

  if (shotCount > 5 || requiredShotBeats.length > 5) {
    score += 1;
    reasons.push("dense-shots");
  }
  if (characters.length >= 4) {
    score += 1;
    reasons.push("many-characters");
  }
  if (requiredEvents.length >= 4) {
    score += 1;
    reasons.push("many-required-events");
  }
  if (forbiddenFutureEvents.length >= 2) {
    score += 1;
    reasons.push("future-event-guard");
  }
  if (sensitivePattern.test(text)) {
    score += 2;
    reasons.push("safety-sensitive");
  }
  if (consistencyItems >= 6) {
    score += 1;
    reasons.push("asset-consistency");
  }

  return { score, reasons };
}

export function chooseRenderScheduleProfile(segments: RenderScheduleSegment[]) {
  const riskScore = Math.max(0, ...segments.map((segment) => scoreSegmentRisk(segment).score));
  if (riskScore >= 6) return "SINGLE";
  if (riskScore >= 4) return "STRICT";
  if (riskScore >= 2) return "BALANCED";
  return "FAST";
}

export function buildRenderPacks<T>(items: T[], options: BuildRenderPackOptions<T> = {}): RenderPackSchedule<T> {
  const getSegment = options.getSegment || defaultSegmentFromItem;
  const segments = items.map(getSegment);
  const riskDetails = segments.map(scoreSegmentRisk);
  const riskScore = Math.max(0, ...riskDetails.map((detail) => detail.score));
  const reasons = Array.from(new Set(riskDetails.flatMap((detail) => detail.reasons)));
  const profile = options.forceProfile || chooseRenderScheduleProfile(segments);
  const { concurrency, packSize } = profileSettings[profile];

  return {
    profile,
    concurrency,
    packSize,
    riskScore,
    reasons,
    packs: buildAdaptiveRiskPacks(items, riskDetails, profile, packSize, concurrency),
  };
}

function defaultSegmentFromItem(item: unknown): RenderScheduleSegment {
  if (!item || typeof item !== "object") return {};
  const record = item as {
    sourceText?: string;
    shotCount?: number;
    segmentContract?: Partial<SegmentContract> | null;
    input?: {
      sourceText?: string;
      shotCount?: number;
      segmentContract?: Partial<SegmentContract> | null;
    };
  };
  return {
    sourceText: record.input?.sourceText || record.sourceText,
    shotCount: record.input?.shotCount || record.shotCount,
    segmentContract: record.input?.segmentContract || record.segmentContract,
  };
}

function chunkBalanced<T>(items: T[], size: number, maxConcurrentPacks: number) {
  if (!items.length) return [];
  const baseSize = Math.max(1, size);
  const maxPacks = Math.max(1, maxConcurrentPacks);
  const packCount = Math.min(maxPacks, Math.ceil(items.length / baseSize));
  const basePackSize = Math.floor(items.length / packCount);
  const extraItems = items.length % packCount;
  const chunks: T[][] = [];
  let index = 0;

  for (let packIndex = 0; packIndex < packCount; packIndex += 1) {
    const packSize = basePackSize + (packIndex < extraItems ? 1 : 0);
    chunks.push(items.slice(index, index + packSize));
    index += packSize;
  }

  return chunks;
}

function buildAdaptiveRiskPacks<T>(
  items: T[],
  riskDetails: Array<ReturnType<typeof scoreSegmentRisk>>,
  profile: RenderScheduleProfile,
  maxPackSize: number,
  maxConcurrentPacks: number,
) {
  if (!items.length) return [];
  if (profile === "SINGLE") return chunkBySize(items, 1);

  const packLimits = riskDetails.map((detail) => Math.min(maxPackSize, packSizeForRiskScore(detail.score)));
  const uniqueLimits = new Set(packLimits);
  if (uniqueLimits.size === 1) {
    const packLimit = packLimits[0] || maxPackSize;
    if (packLimit >= maxPackSize && items.length <= packLimit * maxConcurrentPacks) {
      return chunkBalanced(items, packLimit, maxConcurrentPacks);
    }
    return chunkBySize(items, packLimit);
  }

  const chunks: T[][] = [];
  let currentPack: T[] = [];
  let currentLimit = maxPackSize;

  function flushPack() {
    if (!currentPack.length) return;
    chunks.push(currentPack);
    currentPack = [];
    currentLimit = maxPackSize;
  }

  for (let index = 0; index < items.length; index += 1) {
    const itemLimit = packLimits[index] || maxPackSize;
    const nextLimit = currentPack.length ? Math.min(currentLimit, itemLimit) : itemLimit;
    if (currentPack.length && currentPack.length + 1 > nextLimit) {
      flushPack();
    }
    currentPack.push(items[index]);
    currentLimit = Math.min(currentLimit, itemLimit);
  }

  flushPack();
  return chunks;
}

function packSizeForRiskScore(score: number) {
  if (score >= 6) return 1;
  if (score >= 4) return 2;
  if (score >= 2) return 3;
  if (score >= 1) return 4;
  return 5;
}

function chunkBySize<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  const chunkSize = Math.max(1, size);
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}
