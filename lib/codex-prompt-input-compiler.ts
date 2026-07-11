import {
  collectInternalPromptTokenHits,
  findInternalPromptToken,
  sanitizeInternalPromptTokens,
  sanitizeInternalPromptTokensDeep,
} from "./internal-prompt-token-sanitizer";
import type {
  CharacterContinuityLock,
  SegmentContract,
  SegmentContractEventSlot,
  SegmentContractLock,
  SegmentContractShotBeat,
  SegmentEvidenceSelector,
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

const MAX_COMPACT_CONTRACT_BYTES = 3_072;

export function compileSegmentContractRenderBlock(
  contract: SegmentContract,
  options: { maxBytes?: number } = {},
) {
  const maxBytes = options.maxBytes || MAX_COMPACT_CONTRACT_BYTES;
  const blockingSlots = (contract.requiredEventSlots || []).filter((slot) => slot.importance === "blocking");
  const essentialLines = [
    "段落契约：",
    `- 段号：第 ${contract.segmentIndex} 段`,
    `- 标题：${compileCodexPromptText(contract.title)}`,
    `- 本段时长：${contract.durationSeconds} 秒以内`,
    `- 镜头数量：${contract.shotCount} 个`,
    "",
    "Blocking 事件槽（用于首次生成和可选 Sidecar 证据）：",
    ...formatBlockingEventSlots(blockingSlots),
    "",
    "禁止提前透露的后续信息：",
    ...formatList(contract.forbiddenFutureEvents || [], "无"),
    "",
    "人物连续性锁：",
    ...formatCharacterContinuityLocks(contract.characterLocks || []),
    "",
    "执行规则：",
    "- 最终分镜数量必须等于镜头数量。",
    "- Blocking 事件槽应在允许证据字段中被明确表达，并可在 Sidecar 中按 slotId 引用。",
    "- requiredEvents 只用于剧情理解参考，不做逐字匹配，也不作为程序覆盖依据。",
    "- 人物连续性锁采用不得矛盾规则；本段没有提及锁定事实不算冲突。",
    "- 不得提前呈现禁止提前透露的信息。",
    `- 契约校验码：${contract.contractHash}`,
  ];
  const optionalLines = [
    "",
    `本段原文范围摘要：${truncateUtf8(compileCodexPromptText(contract.sourceText), 420)}`,
    "",
    "requiredEvents 剧情理解参考（不做逐字匹配）：",
    ...formatList(contract.requiredEvents || [], "无"),
    "",
    "角色锁定：",
    ...formatLocks(contract.characters || [], "无"),
    "场景锁定：",
    ...formatLocks(contract.locations || [], "无"),
    "道具和线索锁定：",
    ...formatLocks(contract.props || [], "无"),
    "镜头顺序骨架：",
    ...formatShotBeats(contract.requiredShotBeats || []),
    "",
    "安全和合规要求：",
    ...formatList(contract.safetyPolicy?.avoidTerms || [], "无"),
    ...formatRewriteHints(contract.safetyPolicy?.rewriteHints || {}),
  ];
  const fullText = compileCodexPromptText([...essentialLines, ...optionalLines].join("\n"));
  const fullByteLength = Buffer.byteLength(fullText, "utf8");
  if (fullByteLength <= maxBytes) return { text: fullText, byteLength: fullByteLength, wasCompacted: false };

  const compactText = compileCodexPromptText([
    ...essentialLines,
    "",
    "补充说明：低优先级剧情摘要、普通资产锁和镜头骨架因输入预算已压缩；Blocking 事件槽未删除。",
  ].join("\n"));
  const byteLength = Buffer.byteLength(compactText, "utf8");
  if (byteLength > maxBytes) {
    throw new CodexPromptInputCompilerError(
      `Blocking event slots exceed the compact contract budget (${byteLength}/${maxBytes} UTF-8 bytes); split the segment or revise planning.`,
    );
  }
  return { text: compactText, byteLength, wasCompacted: true };
}

export function segmentContractToChineseRenderBlock(contract: SegmentContract) {
  return compileSegmentContractRenderBlock(contract).text;
}

function formatBlockingEventSlots(slots: SegmentContractEventSlot[]) {
  if (!slots.length) return ["- 无可阻断事件槽；不要根据 requiredEvents 长句自行制造逐字覆盖要求。"];
  return slots.flatMap((slot, index) => [
    `${index + 1}. slotId=${slot.id}；label=${compileCodexPromptText(slot.label)}`,
    `   anchorGroups=${formatGroups(slot.anchorGroups)}`,
    `   conceptGroups=${formatGroups(slot.conceptGroups)}`,
    `   contradictionGroups=${formatGroups(slot.contradictionGroups, "无")}`,
    `   evidenceSelectors / 允许证据路径=${formatEvidenceSelectors(slot.evidenceSelectors)}`,
  ]);
}

function formatGroups(groups: string[][], fallback = "无") {
  const values = (groups || []).map((group) => group
    .slice(0, 6)
    .map((item) => truncateUtf8(compileCodexPromptText(item), 72))
    .filter(Boolean)
    .join(" / "))
    .filter(Boolean);
  return values.length ? values.map((item) => `[${item}]`).join(" + ") : fallback;
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

function formatCharacterContinuityLocks(locks: CharacterContinuityLock[]) {
  if (!locks.length) return ["- 无"];
  return locks.map((lock, index) => {
    const contradictions = formatGroups(lock.contradictionSignals, "仅明确反向事实");
    return `${index + 1}. ${compileCodexPromptText(lock.displayName)}｜${compileCodexPromptText(lock.factKey)}=${compileCodexPromptText(lock.expectedValue)}｜不得矛盾：${contradictions}`;
  });
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}…`, "utf8") > maxBytes) break;
    result += character;
  }
  return `${result}…`;
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

function formatRewriteHints(hints: Record<string, string>) {
  const entries = Object.entries(hints)
    .map(([key, value]) => [compileCodexPromptText(key), compileCodexPromptText(value)] as const)
    .filter(([key, value]) => key && value);
  if (!entries.length) return [];
  return [
    "合规替换方向：",
    ...entries.map(([key, value]) => `- ${key} -> ${value}`),
  ];
}
