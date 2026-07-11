import type { AnalysisResult } from "../types";
import { findInternalPromptToken } from "./internal-prompt-token-sanitizer";

export type BatchSegmentRepairReasonCode = "missing_event" | "continuity_contradiction" | "quality_field";

export type BatchSegmentRepairOperation = {
  slotId?: string;
  path: string;
  replacement: string;
  reasonCode: BatchSegmentRepairReasonCode;
};

export type BatchSegmentRepairPatchResult = {
  schemaVersion: 1;
  contractHash: string;
  resultHash: string;
  repairs: BatchSegmentRepairOperation[];
};

const STORYBOARD_FIELDS = new Set([
  "scene",
  "visual",
  "shotType",
  "composition",
  "cameraMovement",
  "lighting",
  "sound",
  "dialogue",
  "emotion",
  "transition",
  "shotPurpose",
  "firstFramePrompt",
  "videoPrompt",
  "lastFramePrompt",
  "negativePrompt",
]);
const SCALAR_PATHS = new Set([
  "optimizedScript",
  "workflow.fullNegativePrompt",
  "workflow.concisePrompt",
]);
const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

export function normalizeBatchSegmentRepairPath(value: string | undefined) {
  return String(value || "").replace(/^result\./, "").replace(/^sourceResult\./, "").trim();
}

export function isAllowedBatchSegmentRepairPath(value: string) {
  const repairPath = normalizeBatchSegmentRepairPath(value);
  if (SCALAR_PATHS.has(repairPath)) return true;
  const match = repairPath.match(/^storyboard\[(\d+)]\.([A-Za-z][A-Za-z0-9]*)$/);
  return Boolean(match && STORYBOARD_FIELDS.has(match[2]));
}

export function getBatchSegmentRepairValueAtPath(value: unknown, repairPath: string) {
  let cursor = value as Record<string, unknown> | unknown[] | undefined;
  for (const part of splitSafePath(repairPath)) {
    if (cursor == null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part] as Record<string, unknown> | unknown[] | undefined;
  }
  return cursor;
}

export function applyBatchSegmentRepairPatch<T extends AnalysisResult>(
  sourceResult: T,
  patch: BatchSegmentRepairPatchResult,
) {
  return patch.repairs.reduce<T>((current, repair) => {
    const clone = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    const parts = splitSafePath(repair.path);
    let cursor: Record<string, unknown> = clone;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const nextPart = parts[index + 1];
      if (!cursor[part] || typeof cursor[part] !== "object") {
        cursor[part] = /^\d+$/.test(nextPart) ? [] : {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = repair.replacement;
    return clone as T;
  }, sourceResult);
}

export function assertBatchSegmentRepairPatchIsolation(
  before: AnalysisResult,
  after: AnalysisResult,
  allowedPaths: string[],
) {
  const allowed = new Set(allowedPaths.map(normalizeBatchSegmentRepairPath));
  const changedPaths = collectChangedLeafPaths(before, after);
  const unauthorized = changedPaths.filter((path) => !allowed.has(path));
  if (unauthorized.length) {
    throw new Error(`Repair patch changed unauthorized fields: ${unauthorized.join(", ")}`);
  }
  return changedPaths;
}

export function validateBatchSegmentRepairPatchResult(
  value: unknown,
  options: {
    contractHash: string;
    resultHash: string;
    allowedPaths: string[];
    allowedSlotIds?: string[];
    currentValues?: Record<string, string>;
  },
): BatchSegmentRepairPatchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Repair output must be repairs-only JSON");
  const record = value as Record<string, unknown>;
  const topKeys = new Set(["schemaVersion", "contractHash", "resultHash", "repairs"]);
  if (Object.keys(record).some((key) => !topKeys.has(key)) || !Array.isArray(record.repairs)) {
    throw new Error("Repair output must be repairs-only JSON");
  }
  if (record.schemaVersion !== 1 || record.contractHash !== options.contractHash || record.resultHash !== options.resultHash) {
    throw new Error("Repair output hash or schema does not match");
  }
  const allowedPaths = new Set(options.allowedPaths.map(normalizeBatchSegmentRepairPath));
  const allowedSlotIds = new Set((options.allowedSlotIds || []).filter(Boolean));
  if (!record.repairs.length || record.repairs.length > allowedPaths.size) throw new Error("Repair output repairs list is empty or too large");
  const seen = new Set<string>();
  const repairs = record.repairs.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Repair operation is invalid");
    const operation = item as Record<string, unknown>;
    const operationKeys = new Set(["slotId", "path", "replacement", "reasonCode"]);
    if (Object.keys(operation).some((key) => !operationKeys.has(key))) throw new Error("Repair operation contains unknown fields");
    const repairPath = normalizeBatchSegmentRepairPath(String(operation.path || ""));
    if (!allowedPaths.has(repairPath) || !isAllowedBatchSegmentRepairPath(repairPath)) {
      throw new Error(`Repair output contains unauthorized path: ${repairPath || "(empty)"}`);
    }
    if (seen.has(repairPath)) throw new Error(`Repair output contains duplicate path: ${repairPath}`);
    seen.add(repairPath);
    const replacement = String(operation.replacement || "").trim();
    if (!isUsableBatchSegmentRepairReplacement(replacement)) throw new Error(`Repair output contains invalid replacement for ${repairPath}`);
    if (options.currentValues?.[repairPath]?.trim() === replacement) throw new Error(`Repair output did not change ${repairPath}`);
    const reasonCode = String(operation.reasonCode || "");
    if (!(["missing_event", "continuity_contradiction", "quality_field"] as string[]).includes(reasonCode)) {
      throw new Error("Repair operation has invalid reasonCode");
    }
    const slotId = operation.slotId ? String(operation.slotId) : undefined;
    if (slotId && !allowedSlotIds.has(slotId)) throw new Error(`Repair operation contains unknown slotId: ${slotId}`);
    if ((reasonCode === "missing_event" || reasonCode === "continuity_contradiction") && allowedSlotIds.size && !slotId) {
      throw new Error("Event repair operation is missing slotId");
    }
    return {
      slotId,
      path: repairPath,
      replacement,
      reasonCode: reasonCode as BatchSegmentRepairReasonCode,
    };
  });
  return {
    schemaVersion: 1,
    contractHash: options.contractHash,
    resultHash: options.resultHash,
    repairs,
  };
}

export function buildBatchSegmentResultHash(value: unknown) {
  const stable = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sr_${(hash >>> 0).toString(36)}`;
}

function isUsableBatchSegmentRepairReplacement(value: string) {
  if (!value || value.length > 5_000) return false;
  if (findInternalPromptToken(value)) return false;
  if (/\b(?:undefined|null)\b/i.test(value)) return false;
  if (/同上|如上|见上文|^\s*略\s*$/m.test(value)) return false;
  if (/合规说明|审计说明|修改说明|修复说明|字段路径|replacement|patch/i.test(value)) return false;
  return true;
}

function splitSafePath(value: string) {
  const repairPath = normalizeBatchSegmentRepairPath(value);
  if (!isAllowedBatchSegmentRepairPath(repairPath)) throw new Error(`Unsafe repair path: ${repairPath || "(empty)"}`);
  const parts = repairPath.replace(/\[(\d+)]/g, ".$1").split(".").filter(Boolean);
  if (parts.some((part) => FORBIDDEN_PATH_PARTS.has(part))) throw new Error(`Unsafe repair path: ${repairPath}`);
  return parts;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function collectChangedLeafPaths(before: unknown, after: unknown, path = ""): string[] {
  if (Object.is(before, after)) return [];
  const beforeArray = Array.isArray(before);
  const afterArray = Array.isArray(after);
  if (beforeArray || afterArray) {
    if (!beforeArray || !afterArray || before.length !== after.length) return [path || "result"];
    return before.flatMap((item, index) => collectChangedLeafPaths(item, after[index], `${path}[${index}]`));
  }
  const beforeObject = before && typeof before === "object";
  const afterObject = after && typeof after === "object";
  if (beforeObject || afterObject) {
    if (!beforeObject || !afterObject) return [path || "result"];
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    return [...keys].flatMap((key) => collectChangedLeafPaths(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
    ));
  }
  return [path || "result"];
}
