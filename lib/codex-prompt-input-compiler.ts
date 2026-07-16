import {
  collectInternalPromptTokenHits,
  findInternalPromptToken,
  sanitizeInternalPromptTokens,
  sanitizeInternalPromptTokensDeep,
} from "./internal-prompt-token-sanitizer";
import {
  buildSegmentContractHash,
  validateSegmentContract,
  type CharacterContinuityLock,
  type SegmentContract,
  type SegmentContractEventSlot,
  type SegmentContractLock,
  type SegmentContractShotBeat,
  type SegmentEvidenceSelector,
} from "./batch-segment-contract";
import {
  applyPromptSafetyPolicy,
  applyPromptSafetyPolicyDeep,
  type PromptSafetyContext,
  type PromptSafetyPrepassResult,
} from "./prompt-safety-policy";

export class CodexPromptInputCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPromptInputCompilerError";
  }
}

export function compileCodexPromptText(value: unknown, context: Partial<PromptSafetyContext> = {}) {
  const sanitized = sanitizeInternalPromptTokens(String(value ?? ""));
  return applyPromptSafetyPolicy(sanitized, {
    phase: context.phase || "render",
    path: context.path,
    field: context.field,
  }).text;
}

export function compileCodexPromptValueForModel<T>(
  value: T,
  context: PromptSafetyContext,
): PromptSafetyPrepassResult<T> {
  const prepass = applyPromptSafetyPolicyDeep(
    sanitizeInternalPromptTokensDeep(value),
    context,
  );
  return {
    ...prepass,
    sourceTextOriginal: value,
  };
}

export function assertCleanCodexPromptInput(prompt: string, context: string) {
  const hit = findInternalPromptToken(prompt);
  if (!hit) return;
  throw new CodexPromptInputCompilerError(
    `${context} contains internal prompt token "${hit.token}" before Codex generation; compile it to Chinese display text first.`,
  );
}

export function buildChinesePromptLexiconBlock(values: unknown[]) {
  const replacements = new Map<string, string>();
  for (const hit of values.flatMap((value) => collectInternalPromptTokenHits(value))) {
    replacements.set(hit.replacement, hit.replacement);
  }
  const items = [...replacements.keys()].filter(Boolean);
  if (!items.length) return "";
  return [
    "项目中文词典：",
    ...items.map((item) => `- ${item}`),
    "以上中文称呼是唯一可用于成片提示词的称呼。",
  ].join("\n");
}

export const CONTRACT_PROMPT_COMPILER_VERSION = "segment-contract-prompt-v2" as const;
export const CONTRACT_PROMPT_MAX_BYTES = 3_072;

export type ContractCompileSectionBytes = {
  identity: number;
  requiredEventSlots: number;
  forbiddenFutureEvents: number;
  characterLocks: number;
  requiredShotBeats: number;
  safetyPolicy: number;
  executionMetadata: number;
};

export type ContractSemanticManifest = {
  manifestVersion: "segment-contract-semantic-v1";
  segmentIndex: number;
  contractHash: string;
  blockingEventSlots: Array<{
    id: string;
    label: string;
    importance: "blocking";
    anchorGroupHashes: string[];
    conceptGroupHashes: string[];
    contradictionGroupHashes: string[];
    evidenceSelectorHashes: string[];
  }>;
  fallbackRequiredEventHashes: string[];
  forbiddenFutureEventHashes: string[];
  characterLocks: Array<{
    characterId: string;
    factKey: string;
    expectedValue: string;
    mode: "must_not_contradict";
    contradictionGroupHashes: string[];
  }>;
  requiredShotBeats: Array<{
    shotNumber: number;
    beatHash: string;
    visualFocusHash: string;
  }>;
  safetyPolicy: {
    mode: "default" | "rewrite_required";
    avoidTermHashes: string[];
    rewriteHintHashes: string[];
  };
  assetLockHashes: {
    characters: string[];
    locations: string[];
    props: string[];
  };
};

export type CompiledSegmentContractBlock =
  | {
      status: "ready" | "compacted";
      compilerVersion: typeof CONTRACT_PROMPT_COMPILER_VERSION;
      segmentIndex: number;
      contractHash: string;
      text: string;
      byteLength: number;
      maxBytes: number;
      sectionBytes: ContractCompileSectionBytes;
      compactedFields: string[];
      semanticManifest: ContractSemanticManifest;
    }
  | {
      status: "overflow";
      compilerVersion: typeof CONTRACT_PROMPT_COMPILER_VERSION;
      segmentIndex: number;
      contractHash: string;
      byteLength: number;
      maxBytes: number;
      sectionBytes: ContractCompileSectionBytes;
      blockingSemanticBytes: number;
      errorCode: "CONTRACT_BUDGET_EXCEEDED";
      recommendedAction: "review";
      semanticManifest: ContractSemanticManifest;
    }
  | {
      status: "invalid";
      compilerVersion: typeof CONTRACT_PROMPT_COMPILER_VERSION;
      segmentIndex: number;
      contractHash?: string;
      errorCode: "CONTRACT_HASH_INVALID" | "CONTRACT_SCHEMA_INVALID";
      message: string;
    };

type ContractProjectionSections = Record<keyof ContractCompileSectionBytes, string>;

export function compileSegmentContractForPrompt(
  value: unknown,
  options: { maxBytes?: number } = {},
): CompiledSegmentContractBlock {
  const maxBytes = options.maxBytes ?? CONTRACT_PROMPT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Contract prompt maxBytes must be a positive integer");
  }

  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const segmentIndex = Number.isInteger(record.segmentIndex) && Number(record.segmentIndex) > 0
    ? Number(record.segmentIndex)
    : 0;
  const contractHash = typeof record.contractHash === "string" && record.contractHash.trim()
    ? record.contractHash.trim()
    : undefined;

  try {
    validateSegmentContract(value as SegmentContract);
  } catch (error) {
    return {
      status: "invalid",
      compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
      segmentIndex,
      ...(contractHash ? { contractHash } : {}),
      errorCode: "CONTRACT_SCHEMA_INVALID",
      message: error instanceof Error ? error.message : "SegmentContract schema validation failed",
    };
  }

  const contract = value as SegmentContract;
  const expectedHash = buildSegmentContractHash(contract);
  if (contract.contractHash !== expectedHash) {
    return {
      status: "invalid",
      compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
      segmentIndex: contract.segmentIndex,
      contractHash: contract.contractHash,
      errorCode: "CONTRACT_HASH_INVALID",
      message: `SegmentContract ${contract.segmentIndex} hash does not match its content`,
    };
  }

  try {
    const semanticManifest = buildContractSemanticManifest(contract);
    const fullSections = buildContractProjectionSections(contract, false);
    const fullText = joinContractProjectionSections(fullSections);
    const fullByteLength = utf8ByteLength(fullText);
    if (fullByteLength <= maxBytes) {
      return {
        status: "ready",
        compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
        segmentIndex: contract.segmentIndex,
        contractHash: contract.contractHash,
        text: fullText,
        byteLength: fullByteLength,
        maxBytes,
        sectionBytes: measureContractProjectionSections(fullSections),
        compactedFields: [],
        semanticManifest,
      };
    }

    const compactSections = buildContractProjectionSections(contract, true);
    const compactText = joinContractProjectionSections(compactSections);
    const compactByteLength = utf8ByteLength(compactText);
    const compactedFields = [
      "sourceText",
      "requiredEventsDisplayProse",
      "executionInstructions",
    ];
    if (compactByteLength <= maxBytes) {
      return {
        status: "compacted",
        compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
        segmentIndex: contract.segmentIndex,
        contractHash: contract.contractHash,
        text: compactText,
        byteLength: compactByteLength,
        maxBytes,
        sectionBytes: measureContractProjectionSections(compactSections),
        compactedFields,
        semanticManifest,
      };
    }

    const sectionBytes = measureContractProjectionSections(compactSections);
    return {
      status: "overflow",
      compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
      segmentIndex: contract.segmentIndex,
      contractHash: contract.contractHash,
      byteLength: compactByteLength,
      maxBytes,
      sectionBytes,
      blockingSemanticBytes:
        sectionBytes.requiredEventSlots
        + sectionBytes.forbiddenFutureEvents
        + sectionBytes.characterLocks
        + sectionBytes.requiredShotBeats
        + sectionBytes.safetyPolicy,
      errorCode: "CONTRACT_BUDGET_EXCEEDED",
      recommendedAction: "review",
      semanticManifest,
    };
  } catch (error) {
    return {
      status: "invalid",
      compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
      segmentIndex: contract.segmentIndex,
      contractHash: contract.contractHash,
      errorCode: "CONTRACT_SCHEMA_INVALID",
      message: error instanceof Error ? error.message : "SegmentContract projection failed",
    };
  }
}

export function compileSegmentContractRenderBlock(
  contract: SegmentContract,
  options: { maxBytes?: number } = {},
) {
  const compiled = compileSegmentContractForPrompt(contract, options);
  if (compiled.status === "invalid") {
    throw new CodexPromptInputCompilerError(compiled.message);
  }
  if (compiled.status === "overflow") {
    throw new CodexPromptInputCompilerError(
      `Blocking event slots exceed the compact contract budget (${compiled.byteLength}/${compiled.maxBytes} UTF-8 bytes); split the segment or revise planning.`,
    );
  }
  return {
    text: compiled.text,
    byteLength: compiled.byteLength,
    wasCompacted: compiled.status === "compacted",
  };
}

export function segmentContractToChineseRenderBlock(contract: SegmentContract) {
  return compileSegmentContractRenderBlock(contract).text;
}

function buildContractSemanticManifest(contract: SegmentContract): ContractSemanticManifest {
  const blockingSlots = (contract.requiredEventSlots || []).filter((slot) => slot.importance === "blocking");
  const rewriteHintEntries = Object.entries(contract.safetyPolicy?.rewriteHints || {})
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"));
  return {
    manifestVersion: "segment-contract-semantic-v1",
    segmentIndex: contract.segmentIndex,
    contractHash: contract.contractHash,
    blockingEventSlots: blockingSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      importance: "blocking",
      anchorGroupHashes: slot.anchorGroups.map(hashSemanticValue),
      conceptGroupHashes: slot.conceptGroups.map(hashSemanticValue),
      contradictionGroupHashes: slot.contradictionGroups.map(hashSemanticValue),
      evidenceSelectorHashes: slot.evidenceSelectors.map(hashSemanticValue),
    })),
    fallbackRequiredEventHashes: blockingSlots.length
      ? []
      : contract.requiredEvents.map(hashSemanticValue),
    forbiddenFutureEventHashes: contract.forbiddenFutureEvents.map((event) => hashSemanticValue(normalizeSemanticText(event))),
    characterLocks: contract.characterLocks.map((lock) => ({
      characterId: lock.characterId,
      factKey: lock.factKey,
      expectedValue: lock.expectedValue,
      mode: lock.mode,
      contradictionGroupHashes: lock.contradictionSignals.map(hashSemanticValue),
    })),
    requiredShotBeats: contract.requiredShotBeats.map((beat) => ({
      shotNumber: beat.shotNumber,
      beatHash: hashSemanticValue(normalizeSemanticText(beat.beat)),
      visualFocusHash: hashSemanticValue(normalizeSemanticText(beat.visualFocus)),
    })),
    safetyPolicy: {
      mode: contract.safetyPolicy.avoidTerms.length || rewriteHintEntries.length ? "rewrite_required" : "default",
      avoidTermHashes: contract.safetyPolicy.avoidTerms.map((term) => hashSemanticValue(normalizeSemanticText(term))),
      rewriteHintHashes: rewriteHintEntries.map(hashSemanticValue),
    },
    assetLockHashes: {
      characters: contract.characters.map(hashSemanticValue),
      locations: contract.locations.map(hashSemanticValue),
      props: contract.props.map(hashSemanticValue),
    },
  };
}

function buildContractProjectionSections(
  contract: SegmentContract,
  compact: boolean,
): ContractProjectionSections {
  const blockingSlots = contract.requiredEventSlots.filter((slot) => slot.importance === "blocking");
  const identity = compact
    ? [
        "段落契约：",
        `第${contract.segmentIndex}段｜${compileCodexPromptText(contract.title)}｜${contract.durationSeconds}秒｜${contract.shotCount}镜头`,
        `contractHash=${contract.contractHash}｜sourceHash=${contract.sourceHash}｜coverage=${contract.coveragePolicyVersion}`,
      ].join("\n")
    : [
        "段落契约：",
        `- 编译版本：${CONTRACT_PROMPT_COMPILER_VERSION}`,
        `- 段号：第 ${contract.segmentIndex} 段`,
        `- 标题：${compileCodexPromptText(contract.title)}`,
        `- 本段时长：${contract.durationSeconds} 秒以内`,
        `- 镜头数量：${contract.shotCount} 个`,
        `- 契约校验码：${contract.contractHash}`,
        `- 原文校验码：${contract.sourceHash}`,
        `- 覆盖策略：${compileCodexPromptText(contract.coveragePolicyVersion)}`,
      ].join("\n");

  const requiredEventSlots = [
    compact ? "Blocking事件槽：" : "Blocking 事件槽（用于首次生成和可选 Sidecar 证据）：",
    ...formatBlockingEventSlotsExact(blockingSlots, compact),
  ].join("\n");
  const forbiddenFutureEvents = [
    compact ? "禁止后续信息：" : "禁止提前透露的后续信息：",
    ...formatList(contract.forbiddenFutureEvents, "无"),
  ].join("\n");
  const characterLocks = [
    compact ? "人物连续性：" : "人物连续性锁：",
    ...formatCharacterContinuityLocksExact(contract.characterLocks, compact),
  ].join("\n");
  const requiredShotBeats = [
    compact ? "镜头骨架：" : "镜头顺序骨架：",
    ...formatShotBeats(contract.requiredShotBeats),
  ].join("\n");
  const safetyPolicy = [
    compact ? "安全规则：" : "安全和合规要求：",
    ...formatList(contract.safetyPolicy.avoidTerms, "无"),
    ...formatRewriteHintsExact(contract.safetyPolicy.rewriteHints),
  ].join("\n");

  const assetLines = [
    "角色锁定：",
    ...formatLocks(contract.characters, "无"),
    "场景锁定：",
    ...formatLocks(contract.locations, "无"),
    "道具和线索锁定：",
    ...formatLocks(contract.props, "无"),
  ];
  const fallbackEvents = blockingSlots.length
    ? []
    : ["requiredEvents 剧情理解参考：", ...formatList(contract.requiredEvents, "无")];
  const executionMetadata = compact
    ? [
        ...fallbackEvents,
        ...assetLines,
        "执行：镜头数量必须一致；事件槽需在允许路径表达；人物不得与锁定事实矛盾；不得提前透露后续信息。",
      ].join("\n")
    : [
        `本段原文（Render script 已独立携带，本处仅作契约核对）：${compileCodexPromptText(contract.sourceText)}`,
        "requiredEvents 剧情理解参考（不做逐字匹配）：",
        ...formatList(contract.requiredEvents, "无"),
        ...assetLines,
        "执行规则：",
        "- 最终分镜数量必须等于镜头数量。",
        "- Blocking 事件槽应在允许证据字段中被明确表达，并可在 Sidecar 中按 slotId 引用。",
        "- requiredEvents 只用于剧情理解参考，不做逐字匹配，也不作为程序覆盖依据。",
        "- 人物连续性锁采用不得矛盾规则；本段没有提及锁定事实不算冲突。",
        "- 不得提前呈现禁止提前透露的信息。",
      ].join("\n");

  return {
    identity,
    requiredEventSlots,
    forbiddenFutureEvents,
    characterLocks,
    requiredShotBeats,
    safetyPolicy,
    executionMetadata,
  };
}

function joinContractProjectionSections(sections: ContractProjectionSections) {
  return [
    sections.identity,
    sections.requiredEventSlots,
    sections.forbiddenFutureEvents,
    sections.characterLocks,
    sections.requiredShotBeats,
    sections.safetyPolicy,
    sections.executionMetadata,
  ].filter(Boolean).join("\n\n");
}

function measureContractProjectionSections(sections: ContractProjectionSections): ContractCompileSectionBytes {
  return {
    identity: utf8ByteLength(sections.identity),
    requiredEventSlots: utf8ByteLength(sections.requiredEventSlots),
    forbiddenFutureEvents: utf8ByteLength(sections.forbiddenFutureEvents),
    characterLocks: utf8ByteLength(sections.characterLocks),
    requiredShotBeats: utf8ByteLength(sections.requiredShotBeats),
    safetyPolicy: utf8ByteLength(sections.safetyPolicy),
    executionMetadata: utf8ByteLength(sections.executionMetadata),
  };
}

function formatBlockingEventSlotsExact(slots: SegmentContractEventSlot[], compact: boolean) {
  if (!slots.length) return ["- 无可阻断事件槽；不得根据 requiredEvents 长句制造逐字覆盖要求。"];
  return slots.flatMap((slot, index) => compact
    ? [
        `${index + 1}. slotId=${slot.id}｜label=${compileCodexPromptText(slot.label)}｜anchors=${formatGroupsExact(slot.anchorGroups)}｜concepts=${formatGroupsExact(slot.conceptGroups)}｜contradictions=${formatGroupsExact(slot.contradictionGroups, "无")}｜evidence=${formatEvidenceSelectors(slot.evidenceSelectors)}`,
      ]
    : [
        `${index + 1}. slotId=${slot.id}；label=${compileCodexPromptText(slot.label)}；importance=${slot.importance}`,
        `   anchorGroups=${formatGroupsExact(slot.anchorGroups)}`,
        `   conceptGroups=${formatGroupsExact(slot.conceptGroups)}`,
        `   contradictionGroups=${formatGroupsExact(slot.contradictionGroups, "无")}`,
        `   evidenceSelectors / 允许证据路径=${formatEvidenceSelectors(slot.evidenceSelectors)}`,
      ]);
}

function formatCharacterContinuityLocksExact(locks: CharacterContinuityLock[], compact: boolean) {
  if (!locks.length) return ["- 无"];
  return locks.map((lock, index) => {
    const contradictions = formatGroupsExact(lock.contradictionSignals, "仅明确反向事实");
    return compact
      ? `${index + 1}. ${compileCodexPromptText(lock.displayName)}｜${compileCodexPromptText(lock.factKey)}=${compileCodexPromptText(lock.expectedValue)}｜mode=${lock.mode}｜反向=${contradictions}`
      : `${index + 1}. ${compileCodexPromptText(lock.displayName)}｜${compileCodexPromptText(lock.factKey)}=${compileCodexPromptText(lock.expectedValue)}｜mode=${lock.mode}｜不得矛盾：${contradictions}`;
  });
}

function formatGroupsExact(groups: string[][], fallback = "无") {
  const values = groups
    .map((group) => group.map((item) => compileCodexPromptText(item).trim()).filter(Boolean).join(" / "))
    .filter(Boolean);
  return values.length ? values.map((item) => `[${item}]`).join(" + ") : fallback;
}

function formatRewriteHintsExact(hints: Record<string, string>) {
  const entries = Object.entries(hints)
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .map(([key, value]) => [compileCodexPromptText(key), compileCodexPromptText(value)] as const)
    .filter(([key, value]) => key && value);
  return entries.length ? ["合规替换方向：", ...entries.map(([key, value]) => `- ${key} -> ${value}`)] : [];
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeSemanticText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function hashSemanticValue(value: unknown) {
  const stable = stableSemanticStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sm_${(hash >>> 0).toString(36)}`;
}

function stableSemanticStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSemanticStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSemanticStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function formatEvidenceSelectors(selectors: SegmentEvidenceSelector[]) {
  const paths = (selectors || []).flatMap((selector) => {
    if (selector.source === "optimizedScript") return ["optimizedScript"];
    const shotIndex = selector.shotNumber === "any" || selector.shotNumber == null
      ? "*"
      : String(Math.max(0, selector.shotNumber - 1));
    return selector.fields.map((field) => `storyboard[${shotIndex}].${field}`);
  });
  return [...new Set(paths)].join(", ") || "无";
}

function formatList(items: string[], fallback = "无") {
  const cleanItems = items.map((item) => compileCodexPromptText(item).trim()).filter(Boolean);
  return cleanItems.length ? cleanItems.map((item, index) => `${index + 1}. ${item}`) : [`- ${fallback}`];
}

function formatLocks(items: SegmentContractLock[], fallback = "无") {
  const cleanItems = items.flatMap((item, index) => {
    const parts = [
      compileCodexPromptText(item.name),
      item.identity ? `身份：${compileCodexPromptText(item.identity)}` : "",
      item.role ? `作用：${compileCodexPromptText(item.role)}` : "",
      item.visualLock ? `视觉锁定：${compileCodexPromptText(item.visualLock)}` : "",
      item.stateInSegment ? `本段状态：${compileCodexPromptText(item.stateInSegment)}` : "",
    ].filter(Boolean);
    return parts.length ? [`${index + 1}. ${parts.join("；")}`] : [];
  });
  return cleanItems.length ? cleanItems : [`- ${fallback}`];
}

function formatShotBeats(items: SegmentContractShotBeat[]) {
  const cleanItems = items.flatMap((item) => {
    const beat = compileCodexPromptText(item.beat || item.visualFocus).trim();
    if (!beat) return [];
    const timeRange = compileCodexPromptText(item.timeRange).trim();
    const visualFocus = compileCodexPromptText(item.visualFocus).trim();
    return [`镜头 ${item.shotNumber}${timeRange ? `｜${timeRange}` : ""}：${beat}${visualFocus && visualFocus !== beat ? `；画面重点：${visualFocus}` : ""}`];
  });
  return cleanItems.length ? cleanItems : ["- 按本段必须事件设计镜头顺序。"];
}
