import { collectInternalPromptTokenHits, findInternalPromptToken, sanitizeInternalPromptTokens } from "./internal-prompt-token-sanitizer";
import type { SegmentContract, SegmentContractLock, SegmentContractShotBeat } from "./batch-segment-contract";

export class CodexPromptInputCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPromptInputCompilerError";
  }
}

export function compileCodexPromptText(value: unknown) {
  return sanitizeInternalPromptTokens(String(value ?? ""));
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

export function segmentContractToChineseRenderBlock(contract: SegmentContract) {
  const lines = [
    "段落契约：",
    `- 段号：第 ${contract.segmentIndex} 段`,
    `- 标题：${compileCodexPromptText(contract.title)}`,
    `- 本段时长：${contract.durationSeconds} 秒以内`,
    `- 镜头数量：${contract.shotCount} 个`,
    `- 本段原文范围：${compileCodexPromptText(contract.sourceText)}`,
    "",
    "必须覆盖的事件：",
    ...formatList(contract.requiredEvents),
    "",
    "禁止提前透露的后续信息：",
    ...formatList(contract.forbiddenFutureEvents, "无"),
    "",
    "角色锁定：",
    ...formatLocks(contract.characters, "无"),
    "",
    "场景锁定：",
    ...formatLocks(contract.locations, "无"),
    "",
    "道具和线索锁定：",
    ...formatLocks(contract.props, "无"),
    "",
    "镜头顺序骨架：",
    ...formatShotBeats(contract.requiredShotBeats),
    "",
    "安全和合规要求：",
    ...formatList(contract.safetyPolicy?.avoidTerms || [], "无"),
    ...formatRewriteHints(contract.safetyPolicy?.rewriteHints || {}),
    "",
    "执行规则：",
    "- 最终分镜数量必须等于镜头数量。",
    "- 必须覆盖所有必须事件。",
    "- 不得提前呈现禁止提前透露的信息。",
    "- 使用镜头顺序骨架作为镜头推进顺序。",
    "- 人物、地点、道具和线索必须按锁定信息保持一致。",
    `- 契约校验码：${contract.contractHash}`,
  ];
  return compileCodexPromptText(lines.join("\n"));
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
