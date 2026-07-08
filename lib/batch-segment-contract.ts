export type SegmentContractLock = {
  name: string;
  identity?: string;
  visualLock?: string;
  stateInSegment?: string;
  role?: string;
};

export type SegmentContractShotBeat = {
  shotNumber: number;
  timeRange: string;
  beat: string;
  visualFocus: string;
};

export type SegmentContractSafetyPolicy = {
  avoidTerms: string[];
  rewriteHints: Record<string, string>;
};

export type SegmentContractEventSlot = {
  id: string;
  label: string;
  mustIncludeAny: string[];
  mustIncludeOneOf: string[][];
};

export type SegmentContract = {
  segmentIndex: number;
  title: string;
  sourceText: string;
  durationSeconds: number;
  shotCount: number;
  requiredEvents: string[];
  requiredEventSlots?: SegmentContractEventSlot[];
  forbiddenFutureEvents: string[];
  characters: SegmentContractLock[];
  locations: SegmentContractLock[];
  props: SegmentContractLock[];
  requiredShotBeats: SegmentContractShotBeat[];
  safetyPolicy: SegmentContractSafetyPolicy;
  contractHash: string;
};

export type SegmentContractFallback = {
  segmentIndex: number;
  fallbackTitle: string;
  fallbackSourceText: string;
  fallbackDurationSeconds: number;
  fallbackShotCount: number;
  forbiddenFutureEvents?: string[];
};

export function normalizeSegmentContract(raw: unknown, fallback: SegmentContractFallback): SegmentContract {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const segmentIndex = normalizePositiveInteger(record.segmentIndex) || fallback.segmentIndex;
  const title = cleanString(record.title) || fallback.fallbackTitle || `Segment ${segmentIndex}`;
  const sourceText = cleanString(record.sourceText) || fallback.fallbackSourceText || title;
  const durationSeconds = normalizeDurationSeconds(record.durationSeconds ?? record.estimatedDurationSeconds ?? record.duration)
    || fallback.fallbackDurationSeconds
    || 15;
  const shotCount = normalizePositiveInteger(record.shotCount) || fallback.fallbackShotCount || 4;
  const requiredEvents = normalizeStringArray(record.requiredEvents, sourceText);
  const forbiddenFutureEvents = normalizeStringArray(record.forbiddenFutureEvents, "").length
    ? normalizeStringArray(record.forbiddenFutureEvents, "")
    : normalizeStringArray(fallback.forbiddenFutureEvents || [], "");
  const contractWithoutHash = {
    segmentIndex,
    title,
    sourceText,
    durationSeconds: Math.min(15, roundDuration(durationSeconds)),
    shotCount,
    requiredEvents,
    requiredEventSlots: normalizeEventSlots(record.requiredEventSlots),
    forbiddenFutureEvents,
    characters: normalizeLocks(record.characters),
    locations: normalizeLocks(record.locations),
    props: normalizeLocks(record.props),
    requiredShotBeats: normalizeShotBeats(record.requiredShotBeats, shotCount, requiredEvents, sourceText),
    safetyPolicy: normalizeSafetyPolicy(record.safetyPolicy),
  };
  return {
    ...contractWithoutHash,
    contractHash: buildSegmentContractHash(contractWithoutHash),
  };
}

export function validateSegmentContract(contract: SegmentContract, expectedIndex?: number) {
  if (!Number.isInteger(contract.segmentIndex) || contract.segmentIndex < 1) {
    throw new Error("SegmentContract is missing segmentIndex");
  }
  if (expectedIndex && contract.segmentIndex !== expectedIndex) {
    throw new Error(`SegmentContract index ${contract.segmentIndex} does not match expected ${expectedIndex}`);
  }
  if (!contract.title.trim()) throw new Error(`SegmentContract ${contract.segmentIndex} is missing title`);
  if (!contract.sourceText.trim()) throw new Error(`SegmentContract ${contract.segmentIndex} is missing sourceText`);
  if (!contract.durationSeconds || contract.durationSeconds > 15) {
    throw new Error(`SegmentContract ${contract.segmentIndex} exceeds 15 seconds`);
  }
  if (!Number.isInteger(contract.shotCount) || contract.shotCount < 1) {
    throw new Error(`SegmentContract ${contract.segmentIndex} is missing shotCount`);
  }
  if (!contract.requiredEvents.length) {
    throw new Error(`SegmentContract ${contract.segmentIndex} is missing requiredEvents`);
  }
  if (!contract.requiredShotBeats.length) {
    throw new Error(`SegmentContract ${contract.segmentIndex} is missing requiredShotBeats`);
  }
}

export function buildSegmentContractHash(contract: Omit<SegmentContract, "contractHash"> | SegmentContract) {
  const { contractHash: _ignored, ...hashable } = contract as SegmentContract;
  const stable = stableStringify(hashable);
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sc_${(hash >>> 0).toString(36)}`;
}

export function segmentContractToRenderBlock(contract: SegmentContract) {
  return [
    "SEGMENT CONTRACT:",
    JSON.stringify(contract, null, 2),
    "",
    "Contract execution rules:",
    "- Cover every requiredEvents item in this segment.",
    "- Do not reveal or render any forbiddenFutureEvents item.",
    "- The final storyboard length must exactly equal shotCount.",
    "- Use requiredShotBeats as the shot-order spine.",
    "- Preserve characters, locations, props, and safetyPolicy locks.",
    `contractHash: ${contract.contractHash}`,
  ].join("\n");
}

export function findMissingSegmentContractRequiredEvents(promptText: string, contract: SegmentContract) {
  const normalizedPrompt = normalizeEventCoverageText(promptText);
  const slots = contract.requiredEventSlots || [];
  if (slots.length) {
    return slots
      .filter((slot) => !isEventSlotCovered(normalizedPrompt, slot))
      .map((slot) => slot.label || slot.id)
      .filter(Boolean);
  }

  return (contract.requiredEvents || [])
    .filter((event) => normalizeEventCoverageText(event).length >= 4)
    .filter((event) => !isRequiredEventCovered(normalizedPrompt, event));
}

function cleanString(value: unknown) {
  return typeof value === "string" ? cleanSourceEpisodeLabels(value.trim()) : "";
}

function normalizePositiveInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeDurationSeconds(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function roundDuration(value: number) {
  return Number(value.toFixed(1));
}

function normalizeStringArray(value: unknown, fallbackText: string) {
  const items = Array.isArray(value)
    ? value.map((item) => cleanString(item)).filter(Boolean)
    : typeof value === "string"
      ? value.split(/\n|[;；。]/).map((item) => item.trim()).filter(Boolean)
      : [];
  if (items.length) return Array.from(new Set(items)).slice(0, 12);
  const fallback = fallbackText
    .split(/\n|[;；。]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);
  return Array.from(new Set(fallback)).slice(0, 6);
}

function normalizeEventSlots(value: unknown): SegmentContractEventSlot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const slots = value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = cleanString(record.id) || `event_slot_${index + 1}`;
    const label = cleanString(record.label) || id;
    const mustIncludeAny = normalizeStringArray(record.mustIncludeAny, "");
    const rawOneOf = Array.isArray(record.mustIncludeOneOf) ? record.mustIncludeOneOf : [];
    const mustIncludeOneOf = rawOneOf
      .map((group) => normalizeStringArray(group, ""))
      .filter((group) => group.length);
    if (!mustIncludeAny.length && !mustIncludeOneOf.length) return [];
    return [{ id, label, mustIncludeAny, mustIncludeOneOf }];
  });
  return slots.length ? slots : undefined;
}

function normalizeLocks(value: unknown): SegmentContractLock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [{ name: item.trim() }] : [];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const name = cleanString(record.name);
    if (!name) return [];
    return [{
      name,
      identity: cleanString(record.identity) || undefined,
      visualLock: cleanString(record.visualLock) || undefined,
      stateInSegment: cleanString(record.stateInSegment) || undefined,
      role: cleanString(record.role) || undefined,
    }];
  });
}

function normalizeShotBeats(value: unknown, shotCount: number, requiredEvents: string[], sourceText: string): SegmentContractShotBeat[] {
  if (Array.isArray(value)) {
    const beats = value.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const shotNumber = normalizePositiveInteger(record.shotNumber) || index + 1;
      const beat = cleanString(record.beat) || cleanString(record.summary) || cleanString(record.event);
      if (!beat) return [];
      return [{
        shotNumber,
        timeRange: cleanString(record.timeRange),
        beat,
        visualFocus: cleanString(record.visualFocus) || beat,
      }];
    });
    if (beats.length) return beats.slice(0, Math.max(shotCount, beats.length));
  }

  const events = requiredEvents.length ? requiredEvents : normalizeStringArray(sourceText, sourceText);
  const count = Math.max(1, shotCount);
  return Array.from({ length: count }, (_, index) => {
    const event = events[index] || events[events.length - 1] || sourceText;
    return {
      shotNumber: index + 1,
      timeRange: "",
      beat: event,
      visualFocus: event,
    };
  });
}

function isEventSlotCovered(normalizedPrompt: string, slot: SegmentContractEventSlot) {
  const hasRequiredAnchor = !slot.mustIncludeAny.length
    || slot.mustIncludeAny.some((item) => normalizedPrompt.includes(normalizeEventCoverageText(item)));
  if (!hasRequiredAnchor) return false;
  return slot.mustIncludeOneOf.every((group) =>
    group.some((item) => normalizedPrompt.includes(normalizeEventCoverageText(item))),
  );
}

function isRequiredEventCovered(normalizedPrompt: string, event: string) {
  const normalizedEvent = normalizeEventCoverageText(event);
  if (normalizedEvent.length < 4) return true;
  if (normalizedPrompt.includes(normalizedEvent)) return true;
  if (isIdentityEventCovered(normalizedPrompt, normalizedEvent)) return true;

  const eventCore = removeEventCoverageStopWords(normalizedEvent);
  const promptCore = removeEventCoverageStopWords(normalizedPrompt);
  if (eventCore.length < 4) return normalizedPrompt.includes(normalizedEvent);
  if (promptCore.includes(eventCore)) return true;

  const eventBigrams = uniqueBigrams(eventCore);
  if (!eventBigrams.length) return false;
  const distinctiveTokens = eventCore.match(/[\u4e00-\u9fa5]{3,}/g) || [];
  if (
    distinctiveTokens.some((token) => promptCore.includes(token))
    && eventBigrams.some((bigram) => promptCore.includes(bigram))
  ) {
    return true;
  }
  const overlap = eventBigrams.filter((bigram) => promptCore.includes(bigram)).length;
  const requiredOverlap = Math.max(2, Math.ceil(eventBigrams.length * 0.35));
  return overlap >= requiredOverlap;
}

function isIdentityEventCovered(normalizedPrompt: string, normalizedEvent: string) {
  if (!/(?:姓名|身份)/.test(normalizedEvent)) return false;
  const subjectText = normalizedEvent
    .replace(/首次|点出|查到|查明|发现|姓名|身份|信息|正式|档案|字段|出现/g, "");
  const subjectBigrams = uniqueBigrams(subjectText);
  const subjectEvidence = subjectBigrams.filter((bigram) => normalizedPrompt.includes(bigram)).length;
  const identityEvidence = /(?:岁|教师|中学|职业|身份|档案|资料|姓名|年龄)/.test(normalizedPrompt);
  return subjectEvidence >= 2 && identityEvidence;
}

function normalizeEventCoverageText(value: unknown) {
  return cleanString(value)
    .replace(/\s+/g, "")
    .replace(/[，。；：、""''《》【】（）()|\-—–]/g, "")
    .toLowerCase();
}

function removeEventCoverageStopWords(value: string) {
  return value
    .replace(/查到|查明|发现|首次|点出|调查|焦点|从|转向|姓名|身份|有|的|了|一个|本段|需要|确认|继续|开始|出现|信息|正式|档案|字段/g, "");
}

function uniqueBigrams(value: string) {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 2) return [];
  const bigrams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    bigrams.add(compact.slice(index, index + 2));
  }
  return [...bigrams];
}

function normalizeSafetyPolicy(value: unknown): SegmentContractSafetyPolicy {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rewriteHints = record.rewriteHints && typeof record.rewriteHints === "object"
    ? Object.fromEntries(
        Object.entries(record.rewriteHints as Record<string, unknown>)
          .map(([key, item]) => [key, cleanString(item)])
          .filter(([key, item]) => key && item),
      )
    : {};
  return {
    avoidTerms: normalizeStringArray(record.avoidTerms, ""),
    rewriteHints,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanSourceEpisodeLabels(value: string) {
  if (!value) return "";
  return value
    .replace(/原剧本\s*第\s*[0-9一二三四五六七八九十百]+\s*集/g, "原剧本来源段落")
    .replace(/本段为《([^》]+)》第\s*[0-9一二三四五六七八九十百]+\s*集/g, "本段为《$1》来源段落")
    .replace(/来源于《([^》]+)》第\s*[0-9一二三四五六七八九十百]+\s*集/g, "来源于《$1》来源段落");
}
