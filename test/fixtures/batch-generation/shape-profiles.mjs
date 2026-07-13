export const OBSERVED_SHAPE_PROFILE_20 = Object.freeze({
  sourceShapeHash: "03b1c6b11cf2df318513a665fdd681bdf5a43024d9da81eed8784c05b111450d",
  segmentCount: 20,
  scenarioCount: 8,
  shotCountHistogram: Object.freeze({ 4: 20 }),
  observedPromptLengthSummary: Object.freeze({ min: 1361, p50: 2068, p95: 2575, max: 2672 }),
  observedFindingShape: Object.freeze({
    blockingMax: 0,
    patchableMax: 0,
    warningP50: 9,
    riskP50: 1,
    localPatchP95: 8,
    ambiguousSlotP50: 2,
  }),
});

export const OBSERVED_SHAPE_PROFILE_30 = Object.freeze({
  sourceShapeHash: "eb188ea5b81e08e8235c751492682ddfabdc775824d2f368358db8778c8140e7",
  segmentCount: 30,
  scenarioCount: 12,
  shotCountHistogram: Object.freeze({ 4: 5, 5: 25 }),
  observedPromptLengthSummary: Object.freeze({ min: 1956, p50: 2559, p95: 3225, max: 3526 }),
  observedFindingShape: Object.freeze({
    blockingMax: 0,
    patchableMax: 0,
    warningP50: 5,
    riskP50: 3,
    localPatchP95: 11,
    ambiguousSlotP50: 1,
  }),
});
