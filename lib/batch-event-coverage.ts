import type { AnalysisResult } from "../types";
import type {
  CharacterContinuityLock,
  SegmentContract,
  SegmentContractEventSlot,
  SegmentEvidenceField,
  SegmentEvidenceSelector,
  SegmentRepairTarget,
} from "./batch-segment-contract";
import { buildBatchSegmentResultHash } from "./batch-segment-repair-patch";

export type CoverageStatus = "covered" | "definite_missing" | "ambiguous" | "contradiction";

export type CoverageReasonCode =
  | "verified_receipt"
  | "verified_local_bundle"
  | "receipt_missing"
  | "invalid_sidecar_hash"
  | "invalid_evidence_path"
  | "quote_not_found"
  | "partial_concept_match"
  | "absence_not_proven"
  | "required_field_empty"
  | "explicit_contradiction"
  | "insufficient_contract";

export type CoverageDecision = {
  segmentIndex: number;
  slotId: string;
  label: string;
  importance: "blocking" | "advisory";
  status: CoverageStatus;
  evidencePaths: string[];
  evidenceQuotes: string[];
  repairTargets: SegmentRepairTarget[];
  repairPaths: string[];
  reasonCode: CoverageReasonCode;
};

export type SegmentCoverageSidecar = {
  schemaVersion: 1;
  segmentIndex: number;
  contractHash: string;
  resultHash: string;
  receipts: Array<{
    slotId: string;
    evidence: Array<{ path: string; quote: string }>;
  }>;
};

type EvidenceEntry = { path: string; text: string; shotNumber?: number };
type EvidenceBundle = { entries: EvidenceEntry[]; text: string; shotNumber?: number };

const SAFE_EVIDENCE_FIELDS = new Set<SegmentEvidenceField>([
  "visual",
  "dialogue",
  "shotPurpose",
  "videoPrompt",
  "firstFramePrompt",
  "lastFramePrompt",
]);
const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

export function buildSegmentResultHash(result: AnalysisResult) {
  return buildBatchSegmentResultHash(result);
}

export function validateSegmentEventCoverage(
  result: AnalysisResult,
  contract: SegmentContract,
  sidecar?: SegmentCoverageSidecar | null,
) {
  const sidecarState = validateSidecarEnvelope(result, contract, sidecar);
  const decisions = (contract.requiredEventSlots || []).map((slot) =>
    evaluateEventSlot(result, contract, slot, sidecarState.sidecar, sidecarState.failureReason),
  );
  return [...decisions, ...evaluateCharacterContinuityLocks(result, contract)];
}

export function resolveSegmentRepairPaths(result: AnalysisResult, targets: SegmentRepairTarget[], preferredShot?: number) {
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  const paths = targets.flatMap((target) => {
    const shotNumber = target.shotNumber === "best_match"
      ? preferredShot || firstUsableShotNumber(storyboard, target.field)
      : target.shotNumber;
    if (!Number.isInteger(shotNumber) || Number(shotNumber) < 1 || Number(shotNumber) > storyboard.length) return [];
    if (!SAFE_EVIDENCE_FIELDS.has(target.field)) return [];
    return [`storyboard[${Number(shotNumber) - 1}].${target.field}`];
  });
  return Array.from(new Set(paths));
}

export function collectEventCoverageInspectedFields(
  result: AnalysisResult,
  slot: SegmentContractEventSlot,
) {
  const seen = new Set<string>();
  return slot.evidenceSelectors.flatMap((selector) => evidenceEntriesForSelector(result, selector))
    .filter((entry) => {
      if (!entry.text.trim() || seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    })
    .map((entry) => ({ path: entry.path, text: entry.text }));
}

function evaluateEventSlot(
  result: AnalysisResult,
  contract: SegmentContract,
  slot: SegmentContractEventSlot,
  sidecar: SegmentCoverageSidecar | null,
  sidecarFailureReason?: CoverageReasonCode,
): CoverageDecision {
  const weakContract = !slot.anchorGroups.length
    || !slot.conceptGroups.length
    || !slot.evidenceSelectors.length;
  const base = {
    segmentIndex: contract.segmentIndex,
    slotId: slot.id,
    label: slot.label,
    importance: slot.importance,
    repairTargets: slot.repairTargets,
  };
  if (weakContract) {
    return {
      ...base,
      status: "ambiguous",
      evidencePaths: [],
      evidenceQuotes: [],
      repairPaths: [],
      reasonCode: "insufficient_contract",
    };
  }

  const receipt = sidecar?.receipts.find((item) => item.slotId === slot.id);
  if (receipt) {
    const verifiedEntries = verifyReceiptEvidence(result, slot, receipt.evidence);
    if (verifiedEntries.ok) {
      const receiptBundle = makeBundle(verifiedEntries.entries);
      const receiptMatch = matchSlotAgainstBundle(slot, receiptBundle);
      if (receiptMatch.status === "covered") {
        return {
          ...base,
          status: "covered",
          evidencePaths: receiptBundle.entries.map((entry) => entry.path),
          evidenceQuotes: receiptBundle.entries.map((entry) => compactQuote(entry.text)),
          repairPaths: [],
          reasonCode: "verified_receipt",
        };
      }
    } else if (!sidecarFailureReason) {
      sidecarFailureReason = verifiedEntries.reason;
    }
  }

  const bundles = buildEvidenceBundles(result, slot.evidenceSelectors);
  let bestPartial: { bundle: EvidenceBundle; score: number } | null = null;
  for (const bundle of bundles) {
    const match = matchSlotAgainstBundle(slot, bundle);
    if (match.status === "contradiction") {
      return {
        ...base,
        status: "contradiction",
        evidencePaths: bundle.entries.map((entry) => entry.path),
        evidenceQuotes: bundle.entries.map((entry) => compactQuote(entry.text)),
        repairPaths: resolveSegmentRepairPaths(result, slot.repairTargets, bundle.shotNumber),
        reasonCode: "explicit_contradiction",
      };
    }
    if (match.status === "covered") {
      return {
        ...base,
        status: "covered",
        evidencePaths: bundle.entries.map((entry) => entry.path),
        evidenceQuotes: bundle.entries.map((entry) => compactQuote(entry.text)),
        repairPaths: [],
        reasonCode: "verified_local_bundle",
      };
    }
    if (!bestPartial || match.score > bestPartial.score) bestPartial = { bundle, score: match.score };
  }

  const repairPaths = resolveSegmentRepairPaths(result, slot.repairTargets, bestPartial?.bundle.shotNumber);
  const allSelectedFieldsEmpty = bundles.length > 0
    && bundles.every((bundle) => bundle.entries.every((entry) => !entry.text.trim()));
  if (allSelectedFieldsEmpty && repairPaths.length) {
    return {
      ...base,
      status: "definite_missing",
      evidencePaths: [],
      evidenceQuotes: [],
      repairPaths,
      reasonCode: "required_field_empty",
    };
  }

  return {
    ...base,
    status: "ambiguous",
    evidencePaths: bestPartial?.bundle.entries.map((entry) => entry.path) || [],
    evidenceQuotes: bestPartial?.bundle.entries.map((entry) => compactQuote(entry.text)) || [],
    repairPaths,
    reasonCode: sidecarFailureReason
      || (bestPartial && bestPartial.score > 0 ? "partial_concept_match" : sidecar ? "receipt_missing" : "absence_not_proven"),
  };
}

function evaluateCharacterContinuityLocks(result: AnalysisResult, contract: SegmentContract): CoverageDecision[] {
  const entries = allContinuityEvidence(result);
  return (contract.characterLocks || []).flatMap((lock) => {
    const evidence = findContinuityContradiction(entries, lock);
    if (!evidence) return [];
    return [{
      segmentIndex: contract.segmentIndex,
      slotId: `continuity:${lock.characterId}:${lock.factKey}`,
      label: `${lock.displayName}${lock.factKey}连续性`,
      importance: "blocking" as const,
      status: "contradiction" as const,
      evidencePaths: [evidence.path],
      evidenceQuotes: [compactQuote(evidence.text)],
      repairTargets: [],
      repairPaths: isRepairableEvidencePath(evidence.path) ? [evidence.path] : [],
      reasonCode: "explicit_contradiction" as const,
    }];
  });
}

function buildEvidenceBundles(result: AnalysisResult, selectors: SegmentEvidenceSelector[]) {
  const bundles = new Map<string, EvidenceEntry[]>();
  for (const selector of selectors) {
    for (const entry of evidenceEntriesForSelector(result, selector)) {
      const key = entry.shotNumber ? `shot:${entry.shotNumber}` : "optimizedScript";
      const list = bundles.get(key) || [];
      list.push(entry);
      bundles.set(key, list);
    }
  }
  return [...bundles.values()].map(makeBundle);
}

function evidenceEntriesForSelector(result: AnalysisResult, selector: SegmentEvidenceSelector): EvidenceEntry[] {
  if (selector.source === "optimizedScript") {
    return [{ path: "optimizedScript", text: stringValue(result.optimizedScript) }];
  }
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  return storyboard.flatMap((shot, index) => {
    const shotNumber = Number(shot.shotNumber) || index + 1;
    if (selector.shotNumber !== undefined && selector.shotNumber !== "any" && selector.shotNumber !== shotNumber) return [];
    if (selector.requireExecutableShot && !hasExecutableShotContent(shot)) return [];
    return selector.fields.map((field) => ({
      path: `storyboard[${index}].${field}`,
      text: stringValue((shot as Record<string, unknown>)[field]),
      shotNumber,
    }));
  });
}

function makeBundle(entries: EvidenceEntry[]): EvidenceBundle {
  return {
    entries,
    text: entries.map((entry) => entry.text).filter(Boolean).join("\n"),
    shotNumber: entries.find((entry) => entry.shotNumber)?.shotNumber,
  };
}

function matchSlotAgainstBundle(slot: SegmentContractEventSlot, bundle: EvidenceBundle) {
  const text = normalizeCoverageText(bundle.text);
  const contradiction = slot.contradictionGroups
    .flat()
    .find((phrase) => containsPhraseWithPolarity(text, normalizeCoverageText(phrase), true));
  if (contradiction) return { status: "contradiction" as const, score: 100 };
  const anchorMatches = slot.anchorGroups.filter((group) =>
    group.some((phrase) => containsPhraseWithPolarity(text, normalizeCoverageText(phrase), false)),
  ).length;
  const conceptMatches = slot.conceptGroups.filter((group) => conceptGroupMatches(text, bundle.text, group, anchorMatches > 0)).length;
  const anchorsCovered = anchorMatches === slot.anchorGroups.length;
  const conceptsCovered = conceptMatches === slot.conceptGroups.length;
  return {
    status: anchorsCovered && conceptsCovered ? "covered" as const : "ambiguous" as const,
    score: anchorMatches * 10 + conceptMatches * 20,
  };
}

function containsPhraseWithPolarity(text: string, phrase: string, contradictionPhrase: boolean) {
  if (!phrase) return false;
  let index = text.indexOf(phrase);
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - 4), index);
    const phraseContainsNegation = /没|未|不|无/.test(phrase);
    const occurrenceNegated = /(?:没有|并未|未曾|不曾|并不|没|未|不)$/.test(prefix);
    if (phraseContainsNegation || !occurrenceNegated) return true;
    index = text.indexOf(phrase, index + phrase.length);
  }
  return false;
}

function conceptGroupMatches(text: string, rawText: string, group: string[], hasAnchor: boolean) {
  const rhetoricalVariant = text.replace(/这不是([^吗]{1,24})吗/g, "这是$1");
  if (group.some((phrase) => {
    const normalized = normalizeCoverageText(phrase);
    return containsPhraseWithPolarity(text, normalized, false)
      || containsPhraseWithPolarity(rhetoricalVariant, normalized, false);
  })) return true;
  const speechActs = group.map(normalizeCoverageText).some((phrase) => ["承认", "表示", "说", "回答", "坦言"].includes(phrase));
  return speechActs && hasAnchor && /[：:]/.test(rawText);
}

function validateSidecarEnvelope(
  result: AnalysisResult,
  contract: SegmentContract,
  sidecar?: SegmentCoverageSidecar | null,
) {
  if (!sidecar) return { sidecar: null, failureReason: undefined as CoverageReasonCode | undefined };
  if (
    sidecar.schemaVersion !== 1
    || sidecar.segmentIndex !== contract.segmentIndex
    || sidecar.contractHash !== contract.contractHash
    || sidecar.resultHash !== buildSegmentResultHash(result)
  ) {
    return { sidecar: null, failureReason: "invalid_sidecar_hash" as const };
  }
  if (!Array.isArray(sidecar.receipts)) return { sidecar: null, failureReason: "invalid_evidence_path" as const };
  return { sidecar, failureReason: undefined };
}

function verifyReceiptEvidence(
  result: AnalysisResult,
  slot: SegmentContractEventSlot,
  evidence: Array<{ path: string; quote: string }>,
): { ok: true; entries: EvidenceEntry[] } | { ok: false; reason: CoverageReasonCode } {
  const entries: EvidenceEntry[] = [];
  for (const item of evidence.slice(0, slot.importance === "blocking" ? 2 : 1)) {
    const parsed = parseEvidencePath(item.path);
    if (!parsed || !pathAllowedBySelectors(parsed.path, parsed.shotNumber, parsed.field, slot.evidenceSelectors)) {
      return { ok: false, reason: "invalid_evidence_path" };
    }
    const value = readEvidencePath(result, parsed.path);
    if (typeof value !== "string") return { ok: false, reason: "invalid_evidence_path" };
    if (!normalizeQuoteText(value).includes(normalizeQuoteText(item.quote))) return { ok: false, reason: "quote_not_found" };
    entries.push({ path: parsed.path, text: value, shotNumber: parsed.shotNumber });
  }
  return entries.length ? { ok: true, entries } : { ok: false, reason: "receipt_missing" };
}

function parseEvidencePath(value: string) {
  const path = String(value || "").trim();
  if (!path || [...FORBIDDEN_PATH_PARTS].some((part) => path.includes(part))) return null;
  if (path === "optimizedScript") return { path, field: "optimizedScript", shotNumber: undefined };
  const match = path.match(/^storyboard\[(\d+)]\.(visual|dialogue|shotPurpose|videoPrompt|firstFramePrompt|lastFramePrompt)$/);
  if (!match) return null;
  return { path, field: match[2], shotNumber: Number(match[1]) + 1 };
}

function pathAllowedBySelectors(
  path: string,
  shotNumber: number | undefined,
  field: string,
  selectors: SegmentEvidenceSelector[],
) {
  return selectors.some((selector) => {
    if (path === "optimizedScript") return selector.source === "optimizedScript";
    return selector.source === "storyboard"
      && selector.fields.includes(field as SegmentEvidenceField)
      && (selector.shotNumber === undefined || selector.shotNumber === "any" || selector.shotNumber === shotNumber);
  });
}

function readEvidencePath(result: AnalysisResult, path: string) {
  if (path === "optimizedScript") return result.optimizedScript;
  const match = path.match(/^storyboard\[(\d+)]\.([A-Za-z]+)$/);
  if (!match) return undefined;
  return (result.storyboard?.[Number(match[1])] as Record<string, unknown> | undefined)?.[match[2]];
}

function allContinuityEvidence(result: AnalysisResult): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [{ path: "optimizedScript", text: stringValue(result.optimizedScript) }];
  for (const [index, shot] of (result.storyboard || []).entries()) {
    for (const field of SAFE_EVIDENCE_FIELDS) {
      const text = stringValue((shot as Record<string, unknown>)[field]);
      if (text) entries.push({ path: `storyboard[${index}].${field}`, text, shotNumber: index + 1 });
    }
  }
  return entries;
}

function findContinuityContradiction(entries: EvidenceEntry[], lock: CharacterContinuityLock) {
  for (const entry of entries) {
    const normalized = normalizeCoverageText(entry.text);
    if (!normalized.includes(normalizeCoverageText(lock.displayName))) continue;
    for (const signal of lock.contradictionSignals.flat()) {
      if (containsPhraseWithPolarity(normalized, normalizeCoverageText(signal), true)) return entry;
    }
  }
  return null;
}

function hasExecutableShotContent(shot: Record<string, unknown>) {
  return [shot.visual, shot.videoPrompt, shot.firstFramePrompt, shot.lastFramePrompt]
    .some((value) => stringValue(value).trim().length >= 2);
}

function firstUsableShotNumber(storyboard: AnalysisResult["storyboard"], field: SegmentEvidenceField) {
  const best = storyboard.findIndex((shot) => stringValue((shot as Record<string, unknown>)[field]).trim().length > 0);
  return best >= 0 ? best + 1 : storyboard.length ? 1 : 0;
}

function isRepairableEvidencePath(path: string) {
  return /^storyboard\[\d+]\.(visual|dialogue|shotPurpose|videoPrompt|firstFramePrompt|lastFramePrompt)$/.test(path);
}

function normalizeCoverageText(value: unknown) {
  return stringValue(value)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，。；：、“”"'《》【】（）()|\-—–！？!?]/g, "")
    .toLowerCase();
}

function normalizeQuoteText(value: unknown) {
  return stringValue(value).normalize("NFKC").replace(/\s+/g, "").replace(/[，。；：、“”"'！？!?]/g, "");
}

function compactQuote(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
