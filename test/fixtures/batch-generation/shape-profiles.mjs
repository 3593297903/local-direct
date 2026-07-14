import { createHash } from "node:crypto";

const SHOT_FIELDS_20 = Object.freeze({
  scene: Object.freeze({ min: 8, p50: 14, p95: 128, max: 157 }),
  visual: Object.freeze({ min: 51, p50: 90, p95: 124, max: 147 }),
  composition: Object.freeze({ min: 45, p50: 63, p95: 84, max: 86 }),
  cameraMovement: Object.freeze({ min: 20, p50: 49, p95: 66, max: 73 }),
  lighting: Object.freeze({ min: 32, p50: 51, p95: 61, max: 67 }),
  sound: Object.freeze({ min: 23, p50: 46, p95: 64, max: 72 }),
  dialogue: Object.freeze({ min: 1, p50: 21, p95: 35, max: 46 }),
  emotion: Object.freeze({ min: 8, p50: 23, p95: 31, max: 45 }),
  transition: Object.freeze({ min: 7, p50: 26, p95: 37, max: 52 }),
  shotPurpose: Object.freeze({ min: 34, p50: 55, p95: 77, max: 84 }),
  firstFramePrompt: Object.freeze({ min: 47, p50: 70, p95: 106, max: 122 }),
  videoPrompt: Object.freeze({ min: 87, p50: 195, p95: 239, max: 271 }),
  lastFramePrompt: Object.freeze({ min: 33, p50: 55, p95: 73, max: 77 }),
  negativePrompt: Object.freeze({ min: 88, p50: 154, p95: 282, max: 330 }),
});

const SHOT_FIELDS_30 = Object.freeze({
  scene: Object.freeze({ min: 8, p50: 20, p95: 34, max: 41 }),
  visual: Object.freeze({ min: 57, p50: 92, p95: 127, max: 191 }),
  composition: Object.freeze({ min: 49, p50: 72, p95: 97, max: 116 }),
  cameraMovement: Object.freeze({ min: 27, p50: 55, p95: 80, max: 95 }),
  lighting: Object.freeze({ min: 37, p50: 55, p95: 77, max: 88 }),
  sound: Object.freeze({ min: 24, p50: 54, p95: 74, max: 91 }),
  dialogue: Object.freeze({ min: 1, p50: 19, p95: 37, max: 47 }),
  emotion: Object.freeze({ min: 4, p50: 25, p95: 44, max: 69 }),
  transition: Object.freeze({ min: 9, p50: 30, p95: 45, max: 69 }),
  shotPurpose: Object.freeze({ min: 41, p50: 61, p95: 86, max: 101 }),
  firstFramePrompt: Object.freeze({ min: 55, p50: 81, p95: 112, max: 129 }),
  videoPrompt: Object.freeze({ min: 126, p50: 210, p95: 305, max: 399 }),
  lastFramePrompt: Object.freeze({ min: 43, p50: 71, p95: 99, max: 108 }),
  negativePrompt: Object.freeze({ min: 101, p50: 161, p95: 410, max: 479 }),
});

export const OBSERVED_SHAPE_PROFILE_20 = makeProfile({
  schemaVersion: 2,
  segmentCount: 20,
  scenarioCount: 8,
  shotCountHistogram: { 4: 20 },
  promptLengthSummary: { min: 1_361, p50: 2_068, p95: 2_575, max: 2_672 },
  resultByteSummary: { min: 23_407, p50: 29_533, p95: 37_313, max: 43_293 },
  shotFieldLengthSummaries: SHOT_FIELDS_20,
  findingSummary: {
    blocking: { p50: 0, p95: 0, max: 0, total: 0 },
    patchable: { p50: 0, p95: 0, max: 0, total: 0 },
    warning: { p50: 9, p95: 19, max: 19, total: 136 },
    risk: { p50: 1, p95: 14, max: 28, total: 92 },
  },
  localPatchSummary: { p50: 0, p95: 8, max: 8, total: 57 },
  contractByteSummary: { min: 1_755, p50: 1_854, p95: 1_967, max: 2_873 },
  eventSlotShapeSummary: {
    slotsPerSegment: { min: 2, p50: 2, p95: 2, max: 2 },
    anchorGroupsPerSlot: { min: 1, p50: 1, p95: 1, max: 2 },
    conceptGroupsPerSlot: { min: 1, p50: 1, p95: 1, max: 2 },
    repairTargetsPerSlot: { min: 0, p50: 0, p95: 0, max: 0 },
  },
  segmentWorkloadShape: {
    warningCounts: [0, 0, 0, 0, 10, 13, 0, 0, 11, 19, 19, 0, 15, 9, 11, 11, 9, 9, 0, 0],
    riskCounts: [0, 0, 0, 0, 2, 1, 0, 0, 9, 5, 28, 0, 14, 3, 8, 12, 5, 5, 0, 0],
    localPatchCounts: [0, 0, 0, 0, 0, 1, 0, 0, 7, 5, 8, 0, 8, 6, 3, 6, 6, 7, 0, 0],
  },
  contractConstructionShape: {
    slotsPerSegment: 2,
    anchorGroupsPerSlot: 1,
    conceptGroupsPerSlot: 1,
    repairTargetsPerSlot: 0,
    sourceDetailCharacters: 70,
    nearBudgetSegmentCount: 1,
    termsPerGroup: 1,
    nearBudgetTermsPerGroup: 2,
    nearBudgetLabelCharacters: 70,
  },
});

export const OBSERVED_SHAPE_PROFILE_30 = makeProfile({
  schemaVersion: 2,
  segmentCount: 30,
  scenarioCount: 12,
  shotCountHistogram: { 4: 5, 5: 25 },
  promptLengthSummary: { min: 1_956, p50: 2_559, p95: 3_225, max: 3_526 },
  resultByteSummary: { min: 29_160, p50: 38_246, p95: 49_770, max: 50_383 },
  shotFieldLengthSummaries: SHOT_FIELDS_30,
  findingSummary: {
    blocking: { p50: 0, p95: 0, max: 0, total: 0 },
    patchable: { p50: 0, p95: 0, max: 0, total: 0 },
    warning: { p50: 5, p95: 12, max: 12, total: 171 },
    risk: { p50: 3, p95: 15, max: 23, total: 156 },
  },
  localPatchSummary: { p50: 4, p95: 11, max: 11, total: 147 },
  contractByteSummary: { min: 1_834, p50: 2_209, p95: 2_606, max: 2_606 },
  eventSlotShapeSummary: {
    slotsPerSegment: { min: 1, p50: 1, p95: 1, max: 1 },
    anchorGroupsPerSlot: { min: 2, p50: 3, p95: 4, max: 4 },
    conceptGroupsPerSlot: { min: 1, p50: 2, p95: 3, max: 3 },
    repairTargetsPerSlot: { min: 2, p50: 2, p95: 2, max: 2 },
  },
  segmentWorkloadShape: {
    warningCounts: [7, 4, 0, 7, 6, 2, 3, 5, 5, 4, 6, 5, 5, 1, 12, 8, 5, 3, 7, 5, 4, 2, 5, 11, 9, 6, 12, 2, 11, 9],
    riskCounts: [10, 15, 0, 12, 2, 8, 2, 3, 1, 4, 3, 2, 2, 0, 1, 3, 2, 10, 4, 9, 23, 0, 12, 1, 4, 0, 0, 6, 6, 11],
    localPatchCounts: [11, 11, 0, 8, 4, 10, 4, 4, 4, 8, 2, 6, 2, 0, 6, 2, 3, 8, 8, 5, 8, 1, 5, 4, 4, 2, 2, 6, 7, 2],
  },
  contractConstructionShape: {
    slotsPerSegment: 1,
    anchorGroupsPerSlot: 3,
    conceptGroupsPerSlot: 2,
    repairTargetsPerSlot: 2,
    sourceDetailCharacters: 125,
    nearBudgetSegmentCount: 2,
    termsPerGroup: 3,
    nearBudgetTermsPerGroup: 3,
    nearBudgetLabelCharacters: 70,
  },
});

export function computeObservedShapeProfileHash(profile) {
  const numericProfile = structuredClone(profile);
  delete numericProfile.sourceShapeHash;
  return createHash("sha256")
    .update(canonicalizeNumericProfile(numericProfile), "utf8")
    .digest("hex");
}

function makeProfile(numericProfile) {
  const profile = {
    ...numericProfile,
    sourceShapeHash: computeObservedShapeProfileHash(numericProfile),
  };
  return deepFreeze(profile);
}

function canonicalizeNumericProfile(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
