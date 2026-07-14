import { createHash } from "node:crypto";

import { SYNTHETIC_SCENARIOS } from "./synthetic-scenarios.mjs";

const PATCH_RECIPE_FIELDS = Object.freeze([
  "scene",
  "visual",
  "composition",
  "lighting",
  "sound",
  "emotion",
  "firstFramePrompt",
  "videoPrompt",
  "lastFramePrompt",
]);

const PATCH_RECIPE_LENGTHS = Object.freeze({
  scene: 7,
  visual: 35,
  composition: 23,
  lighting: 19,
  sound: 15,
  emotion: 3,
  firstFramePrompt: 23,
  videoPrompt: 39,
  lastFramePrompt: 23,
});

const SAFE_DETAIL_FRAGMENTS = Object.freeze([
  "人物站位沿既定轴线保持连续",
  "道具方向在动作前后清楚可辨",
  "环境材质保留自然磨损与反光",
  "镜头节奏服从当前动作的起落",
  "前后景层次明确且主体无遮挡",
  "同期声与手部动作准确对应",
  "光线变化维持真实空间纵深",
  "人物视线自然引向下一步动作",
]);

export function canonicalizeFixture(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function computeFixtureHash(value) {
  return hashText(canonicalizeFixture(value));
}

export function cloneFixture(value) {
  return structuredClone(value);
}

export function freezeFixture(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) freezeFixture(item);
  return value;
}

export function createBatchGenerationFixture({ fixtureId, segmentCount, shapeProfile }) {
  if (shapeProfile.segmentCount !== segmentCount) {
    throw new Error(`Shape profile segment count ${shapeProfile.segmentCount} does not match ${segmentCount}`);
  }
  const scenarios = SYNTHETIC_SCENARIOS.slice(0, shapeProfile.scenarioCount);
  const shotCounts = expandHistogram(shapeProfile.shotCountHistogram, segmentCount);
  const totalShotCount = shotCounts.reduce((total, count) => total + count, 0);
  const fieldLengthBudgets = Object.fromEntries(
    Object.entries(shapeProfile.shotFieldLengthSummaries).map(([field, summary], fieldIndex) => [
      field,
      rotateValues(createDistributionTargets(summary, totalShotCount), fieldIndex * 7),
    ]),
  );
  const promptLengthBudgets = createDistributionTargets(shapeProfile.promptLengthSummary, segmentCount);
  const resultByteTargets = createDistributionTargets(shapeProfile.resultByteSummary, segmentCount);
  const contracts = [];
  const renderedResults = [];
  const qualityContext = [];
  const expectedPatchPaths = new Set();
  let globalShotOffset = 0;

  for (let index = 1; index <= segmentCount; index += 1) {
    const scenario = scenarios[(index - 1) % scenarios.length];
    const shotCount = shotCounts[index - 1];
    const workload = {
      warningCount: shapeProfile.segmentWorkloadShape.warningCounts[index - 1],
      riskCount: shapeProfile.segmentWorkloadShape.riskCounts[index - 1],
      localPatchCount: shapeProfile.segmentWorkloadShape.localPatchCounts[index - 1],
    };
    const contract = createContract(index, scenario, shotCount, shapeProfile);
    const patchRecipePaths = createPatchRecipePaths(index, shotCount, workload.localPatchCount);
    patchRecipePaths.forEach((path) => expectedPatchPaths.add(path));
    const result = createResult(index, scenario, shotCount, {
      workload,
      promptLength: promptLengthBudgets[index - 1],
      fieldLengthBudgets,
      globalShotOffset,
      patchRecipePaths,
    });
    contracts.push(contract);
    renderedResults.push(result);
    qualityContext.push({
      episodeIndex: index,
      expectedShotCount: shotCount,
      minFullPromptLength: 900,
      coverageMode: "shadow",
    });
    globalShotOffset += shotCount;
  }
  const resultByteBudgets = assignBudgetsByWeight(
    resultByteTargets,
    renderedResults.map((result) => Buffer.byteLength(JSON.stringify(result), "utf8")),
  );
  renderedResults.forEach((result, index) => padResultJsonBytes(result, resultByteBudgets[index]));
  const baseScript = buildSyntheticBaseScript(contracts);

  return freezeFixture({
    schemaVersion: 1,
    fixtureId,
    sourceHash: hashText(`local-director-phase-zero:${fixtureId}:synthetic-source-v2`),
    baseScript,
    requestedDuration: "15秒以内",
    segmentCount,
    contracts,
    renderedResults,
    qualityContext,
    mutationCases: [
      {
        id: "canonical-text-change",
        segmentIndex: 1,
        operation: "append",
        path: "storyboard[0].visual",
        value: "合成反向变异标记改变最终镜头文本。",
      },
      {
        id: "affirmative-executable-risk",
        segmentIndex: 2,
        operation: "replace",
        path: "storyboard[0].visual",
        value: "镜头展示尸体面部细节，形成明确可执行的肯定画面。",
        expectedClassification: "blocking",
      },
      {
        id: "negated-fact-safety-polarity",
        segmentIndex: 2,
        operation: "replace",
        path: "diagnosis[0]",
        value: "合成资料复核未发现性侵迹象，只记录否定检查结论。",
        expectedClassification: "warning",
      },
      {
        id: "negative-constraint-safety-polarity",
        segmentIndex: 3,
        operation: "replace",
        path: "storyboard[0].negativePrompt",
        value: "避免尸体画面，只保留抽象状态提示。",
        expectedClassification: "risk",
      },
      {
        id: "missing-storyboard",
        segmentIndex: 3,
        operation: "replace",
        path: "storyboard",
        value: [],
        expectedRoute: "regenerate_segment",
        expectedInvocationKind: "single_generation",
      },
    ],
    expected: {
      acceptedSegmentIndexes: Array.from({ length: segmentCount }, (_, index) => index + 1),
      needsReviewSegmentIndexes: [],
      blockingFindingFingerprints: [],
      uniquePatchPaths: [...expectedPatchPaths].sort(),
      adapterVersion: "frozen-dashboard-local-v2",
      productionSourceFingerprint: "805aa2b46f96d33fd89c5fa4a82a8d7390bde1983c0f62139a988e0d2a78a237",
    },
  });
}

export function createFixtureManifest(fixture, shapeProfile, contractByteSummary) {
  const promptLengths = fixture.renderedResults.map((result) => compactLength(result.workflow.fullVideoPrompt));
  const canonicalPromptLengths = fixture.renderedResults.map((result) => compactLength(result.workflow.filmScript));
  const resultJsonBytes = fixture.renderedResults.map((result) => Buffer.byteLength(JSON.stringify(result), "utf8"));
  const scenarioIds = new Set(fixture.renderedResults.map((result) => result.fixtureSentinel.scenarioId));
  const shotCountHistogram = histogram(fixture.renderedResults.map((result) => result.storyboard.length));
  const shotFieldLengthSummaries = Object.fromEntries(
    Object.keys(shapeProfile.shotFieldLengthSummaries).map((field) => [
      field,
      summarize(fixture.renderedResults.flatMap((result) => result.storyboard.map((shot) => compactLength(shot[field])))),
    ]),
  );
  const totalSlots = fixture.contracts.reduce((total, contract) => total + contract.requiredEventSlots.length, 0);
  const anchorGroupCounts = fixture.contracts.flatMap((contract) =>
    contract.requiredEventSlots.map((slot) => slot.anchorGroups.length));
  const conceptGroupCounts = fixture.contracts.flatMap((contract) =>
    contract.requiredEventSlots.map((slot) => slot.conceptGroups.length));
  const repairTargetCounts = fixture.contracts.flatMap((contract) =>
    contract.requiredEventSlots.map((slot) => slot.repairTargets.length));
  const generatedFindingSummary = {
    blocking: { p50: 0, p95: 0, max: 0, total: 0 },
    patchable: { p50: 0, p95: 0, max: 0, total: 0 },
    warning: summarize(shapeProfile.segmentWorkloadShape.warningCounts),
    risk: summarize(shapeProfile.segmentWorkloadShape.riskCounts),
  };
  const generatedLocalPatchSummary = summarize(shapeProfile.segmentWorkloadShape.localPatchCounts);
  const generatedShapeProfile = {
    segmentCount: fixture.segmentCount,
    shotCountHistogram,
    promptLengthSummary: summarize(promptLengths),
    canonicalPromptLengthSummary: summarize(canonicalPromptLengths),
    resultByteSummary: summarize(resultJsonBytes),
    shotFieldLengthSummaries,
    findingSummary: generatedFindingSummary,
    localPatchSummary: generatedLocalPatchSummary,
    contractByteSummary,
    eventSlotShapeSummary: {
      totalSlots,
      anchorGroups: summarize(anchorGroupCounts),
      conceptGroups: summarize(conceptGroupCounts),
      repairTargets: summarize(repairTargetCounts),
      characterLocks: summarize(fixture.contracts.map((contract) => contract.characterLocks.length)),
    },
  };
  const shapeDeltas = buildShapeDeltas(shapeProfile, generatedShapeProfile);

  return freezeFixture({
    fixtureSchemaVersion: 2,
    fixtureId: fixture.fixtureId,
    sourceShapeHash: shapeProfile.sourceShapeHash,
    segmentCount: fixture.segmentCount,
    scenarioCount: scenarioIds.size,
    shotCountHistogram,
    promptLengthSummary: generatedShapeProfile.promptLengthSummary,
    canonicalPromptLengthSummary: generatedShapeProfile.canonicalPromptLengthSummary,
    resultByteSummary: generatedShapeProfile.resultByteSummary,
    shotFieldLengthSummaries,
    contractByteSummary,
    safetyPolarityCounts: {
      negatedFact: fixture.mutationCases.filter((item) => item.id === "negated-fact-safety-polarity").length,
      negativeConstraint: fixture.mutationCases.filter((item) => item.id === "negative-constraint-safety-polarity").length,
      affirmativeExecutableMutation: fixture.mutationCases.filter((item) =>
        item.id === "affirmative-executable-risk").length,
    },
    eventSlotShapeSummary: {
      totalSlots,
      anchorGroups: summarize(anchorGroupCounts),
      conceptGroups: summarize(conceptGroupCounts),
      repairTargets: summarize(repairTargetCounts),
      characterLocks: summarize(fixture.contracts.map((contract) => contract.characterLocks.length)),
    },
    expectedRouteCounts: { accept: fixture.segmentCount },
    expectedLocalPatchOperations: generatedLocalPatchSummary.total,
    expectedUniquePatchPaths: fixture.expected.uniquePatchPaths,
    observedShapeProfile: shapeProfile,
    generatedShapeProfile,
    shapeDeltas,
    shapeAcceptance: {
      passed: shapeDeltas.every((item) => item.accepted),
      checks: shapeDeltas,
    },
  });
}

function createContract(segmentIndex, scenario, shotCount, shapeProfile) {
  const selectedActions = selectActions(scenario.actions, shotCount);
  const primaryAction = selectedActions[0];
  const closingAction = selectedActions.at(-1);
  const [firstPerson, secondPerson] = scenario.people;
  const [firstWardrobe, secondWardrobe] = scenario.wardrobe;
  const [primaryProp, secondaryProp, closingProp] = scenario.props;
  const construction = shapeProfile.contractConstructionShape;
  const nearBudgetLimit = segmentIndex > shapeProfile.segmentCount - construction.nearBudgetSegmentCount;
  const sourceText = fitCompactText(
    `完全合成样本第${segmentIndex}段：${scenario.theme}，按镜头顺序完成建立、核对、确认和收束。`,
    nearBudgetLimit ? 420 : construction.sourceDetailCharacters,
    segmentIndex,
  );
  const slotDefinitions = [
    {
      suffix: "primary_action",
      label: `${primaryProp}完成本段核心核对动作`,
      anchors: [primaryProp, secondaryProp, primaryAction[2], primaryAction[1]],
      concepts: [primaryAction[1], primaryAction[2], scenario.title],
    },
    {
      suffix: "joint_close",
      label: `${firstPerson}与${secondPerson}共同确认${closingProp}归位`,
      anchors: [primaryProp, closingProp, firstPerson, secondPerson],
      concepts: [closingAction[1], closingAction[2], scenario.title],
    },
    {
      suffix: "continuity_verified",
      label: "人物服装、道具方向、空间轴线与十五秒内的动作顺序保持连续",
      anchors: [firstPerson, secondPerson, firstWardrobe, secondWardrobe, primaryProp],
      concepts: ["保持连续", "方向一致", "轴线稳定", "动作顺序", `${shotCount}镜头衔接`],
    },
  ];
  const requiredEventSlots = Array.from({ length: construction.slotsPerSegment }, (_, slotIndex) => {
    const definition = slotDefinitions[slotIndex % slotDefinitions.length];
    const anchorCount = Math.min(
      definition.anchors.length,
      construction.anchorGroupsPerSlot + (nearBudgetLimit && slotIndex === 0 ? 1 : 0),
    );
    const conceptCount = Math.min(
      definition.concepts.length,
      construction.conceptGroupsPerSlot + (nearBudgetLimit && slotIndex === 0 ? 1 : 0),
    );
    return createEventSlot(
      segmentIndex,
      definition.suffix,
      nearBudgetLimit
        ? fitCompactText(
          definition.label,
          compactLength(definition.label) + construction.nearBudgetLabelCharacters,
          segmentIndex + slotIndex,
        )
        : definition.label,
      definition.anchors.slice(0, anchorCount),
      definition.concepts.slice(0, conceptCount),
      construction.repairTargetsPerSlot,
      nearBudgetLimit ? construction.nearBudgetTermsPerGroup : construction.termsPerGroup,
    );
  });
  const contractWithoutHash = {
    contractSchemaVersion: 2,
    coveragePolicyVersion: "2026-07-10.1",
    sourceHash: hashText(sourceText),
    segmentIndex,
    title: `第${segmentIndex}段｜${scenario.title}`,
    sourceText,
    durationSeconds: shotCount * 3,
    shotCount,
    requiredEvents: [
      `${primaryProp}完成核对`,
      `${firstPerson}与${secondPerson}确认${closingProp}归位`,
    ],
    requiredEventSlots,
    forbiddenFutureEvents: [`下一段尚未开始的合成场景最终结论`],
    characterLocks: [
      {
        characterId: `${scenario.id}-primary`,
        displayName: firstPerson,
        factKey: "服装",
        expectedValue: firstWardrobe,
        mode: "must_not_contradict",
        contradictionSignals: [["更换亮红礼服"], ["突然换装"]],
        appliesFromSegment: segmentIndex,
        appliesThroughSegment: segmentIndex,
      },
    ],
    characters: [
      { name: firstPerson, identity: "完全虚构的执行角色", visualLock: firstWardrobe, role: "执行核心动作" },
      { name: secondPerson, identity: "完全虚构的复核角色", visualLock: secondWardrobe, role: "复核并确认" },
    ],
    locations: [
      { name: scenario.location, identity: "完全虚构的测试空间", visualLock: `${scenario.lighting}，无真实机构标识` },
    ],
    props: scenario.props.map((name, index) => ({
      name,
      identity: "完全合成的测试道具",
      visualLock: index === 0 ? "始终处于主要动作区" : "外观与方向保持连续",
    })),
    requiredShotBeats: selectedActions.map((action, offset) => ({
      shotNumber: offset + 1,
      timeRange: `${offset * 3}s-${(offset + 1) * 3}s`,
      beat: action[1],
      visualFocus: action[2],
    })),
    safetyPolicy: {
      avoidTerms: ["真实机构标识", "可识别个人资料", "具体伤害细节"],
      rewriteHints: {
        "真实机构标识": "抽象几何标记",
        "可识别个人资料": "虚构色块卡",
        "具体伤害细节": "克制的抽象状态提示",
      },
    },
  };
  return {
    ...contractWithoutHash,
    contractHash: `sc_${hashText(canonicalizeFixture(contractWithoutHash)).slice(0, 16)}`,
  };
}

function buildSyntheticBaseScript(contracts) {
  return contracts.map((contract) => [
    contract.title,
    `时长：${contract.durationSeconds}秒`,
    ...contract.requiredShotBeats.map((shot) => (
      `${shot.timeRange}｜镜头${shot.shotNumber}｜${shot.beat}`
    )),
    `原文范围：${contract.sourceText}`,
  ].join("\n")).join("\n\n");
}

function createEventSlot(segmentIndex, suffix, label, anchors, concepts, repairTargetCount, termsPerGroup) {
  return {
    id: `segment_${String(segmentIndex).padStart(3, "0")}_${suffix}`,
    label,
    importance: "blocking",
    anchorGroups: anchors.map((anchor, index) => expandEventGroupTerms(anchor, termsPerGroup, index)),
    conceptGroups: concepts.map((concept, index) => expandEventGroupTerms(concept, termsPerGroup, index + 3)),
    contradictionGroups: [["核对失败"], ["道具遗失"]],
    evidenceSelectors: [
      {
        source: "storyboard",
        shotNumber: "any",
        fields: ["visual", "dialogue", "shotPurpose", "videoPrompt"],
        requireExecutableShot: true,
      },
    ],
    repairTargets: [
      { shotNumber: "best_match", field: "videoPrompt" },
      { shotNumber: "best_match", field: "shotPurpose" },
    ].slice(0, repairTargetCount),
  };
}

function expandEventGroupTerms(value, count, seed) {
  const suffixes = [
    "保持原有外观与方向",
    "在当前镜头动作中清楚可见",
    "与人物站位和空间轴线连续",
    "在收束动作完成前不得移位",
    "由前后景关系共同提供证据",
  ];
  return Array.from({ length: Math.max(1, count) }, (_, index) =>
    index === 0 ? value : `${value}${suffixes[(seed + index - 1) % suffixes.length]}`);
}

function createResult(segmentIndex, scenario, shotCount, options) {
  const { workload, fieldLengthBudgets, globalShotOffset } = options;
  const patchRecipePaths = new Set(options.patchRecipePaths);
  const storyboard = selectActions(scenario.actions, shotCount)
    .map((action, offset) => createShot(segmentIndex, scenario, offset, action, shotCount, {
      globalShotIndex: globalShotOffset + offset,
      fieldLengthBudgets,
      patchRecipePaths,
    }));
  const fullVideoPrompt = buildFullPrompt(
    segmentIndex,
    scenario,
    storyboard,
    shotCount,
    options.promptLength,
  );
  const editingNotes = [
    `保持${shotCount}镜头与${shotCount * 3}秒结构；所有名称、地点和编号均为合成测试内容。`,
    ...createSafetyShapeMarkers("warning", workload.warningCount, segmentIndex),
    ...createSafetyShapeMarkers("risk", workload.riskCount, segmentIndex),
  ];
  const result = {
    title: `第${segmentIndex}段｜${scenario.title}`,
    contentType: "完全合成叙事实验短片",
    duration: `${shotCount * 3}秒`,
    style: `克制写实、${scenario.lighting}、稳定运镜、清晰空间关系`,
    diagnosis: ["合成样本用于测量字段完整度、格式保留和本地质量处理。"],
    optimizedScript: `${scenario.people.join("与")}在${scenario.location}完成第${segmentIndex}段任务，镜头依次建立空间、推进动作、核对状态并完成收束。`,
    recommendedItems: [],
    editingNotes,
    workflow: {
      sourceAnalysis: `本段围绕${scenario.theme}展开，重点是可执行动作、清晰因果与稳定空间连续性。`,
      screenplay: storyboard.map((shot) => sanitizeSyntheticSafetyMarker(shot.visual).split("。")[0]).join("；"),
      filmScript: fullVideoPrompt,
      concisePrompt: `${scenario.location}内，${scenario.people.join("与")}完成${scenario.title}。`,
      fullVideoPrompt,
      fullNegativePrompt: "避免真实机构标识、可识别个人资料、字幕水印、低清画面、人物变形、无关道具和跳轴。",
      canonicalHash: hashText(fullVideoPrompt),
    },
    storyboard,
    fixtureSentinel: {
      fixture: "phase-zero-synthetic",
      scenarioId: scenario.id,
      segmentIndex,
      caseType: "normal-clean",
      immutable: true,
    },
  };
  return result;
}

function createShot(segmentIndex, scenario, offset, action, shotCount, options) {
  const [scene, actionText, focus, movement] = action;
  const resolvedScene = `${scenario.location}${scene}工作区`;
  const shotNumber = offset + 1;
  const timeRange = `${offset * 3}s-${(offset + 1) * 3}s`;
  const [firstPerson, secondPerson] = scenario.people;
  const [firstWardrobe, secondWardrobe] = scenario.wardrobe;
  const baseValues = {
    scene: resolvedScene,
    visual: `${actionText}。${scenario.props.join("、")}方向清楚，${firstPerson}的${firstWardrobe}与${secondPerson}的${secondWardrobe}沿稳定轴线连续出现。`,
    composition: `${focus}处在主要视觉区，两名人物分列前后景，环境边缘形成引导线并保留动作空间。`,
    cameraMovement: movement,
    lighting: `${scenario.lighting}建立基础层次，侧光勾勒道具和人物手部，背景压低一级并保持自然曝光。`,
    sound: `保留${scenario.ambient}，动作完成时加入对应的克制同期声，不使用背景音乐。`,
    dialogue: shotNumber === shotCount
    ? `${secondPerson}低声确认：“第${segmentIndex}段已经核对，可以完成收束。”`
      : `${firstPerson}说明当前动作，${secondPerson}简短确认。`,
    emotion: "专注克制并逐步形成确认感",
    transition: shotNumber === shotCount ? "当前动作与同期声共同收束" : "手部动作匹配切入下一镜",
    shotPurpose: `呈现${focus}并通过明确动作推进${scenario.title}的因果链，为下一镜保留自然视觉方向。`,
    firstFramePrompt: `电影级写实首帧，${resolvedScene}完整可见，${focus}处于清晰焦平面，人物服装、站位和道具方向连续。`,
    videoPrompt: `${shotCount * 3}秒短片第${shotNumber}镜，${movement}；${actionText}，构图让${focus}清楚可辨，${scenario.lighting}塑造真实材质，人物动作克制连贯，只保留${scenario.ambient}等同期细节。`,
    lastFramePrompt: `${actionText}完成后的定格瞬间，${focus}保持清晰，人物视线指向下一动作，空间和道具位置连续。`,
    negativePrompt: "避免字幕水印、真实品牌、可识别个人资料、低清模糊、过曝、人物变形、多余肢体、无关道具、跳轴和突兀转场。",
  };
  const valueFor = (field) => {
    const path = `storyboard[${offset}].${field}`;
    const target = options.patchRecipePaths.has(path)
      ? PATCH_RECIPE_LENGTHS[field]
      : options.fieldLengthBudgets[field][options.globalShotIndex];
    const base = baseValues[field];
    if (field === "dialogue" && target === 1) return "无";
    return fitCompactText(base, target, options.globalShotIndex + field.length);
  };
  return {
    shotNumber,
    timeRange,
    scene: valueFor("scene"),
    visual: valueFor("visual"),
    shotType: shotNumber === 1 ? "中远景" : shotNumber === shotCount ? "中近景" : "近景",
    composition: valueFor("composition"),
    cameraMovement: valueFor("cameraMovement"),
    lighting: valueFor("lighting"),
    sound: valueFor("sound"),
    dialogue: valueFor("dialogue"),
    emotion: valueFor("emotion"),
    transition: valueFor("transition"),
    shotPurpose: valueFor("shotPurpose"),
    firstFramePrompt: valueFor("firstFramePrompt"),
    videoPrompt: valueFor("videoPrompt"),
    lastFramePrompt: valueFor("lastFramePrompt"),
    negativePrompt: valueFor("negativePrompt"),
  };
}

function createPatchRecipePaths(segmentIndex, shotCount, patchCount) {
  const candidates = Array.from({ length: shotCount }, (_, shotOffset) => (
    PATCH_RECIPE_FIELDS.map((field) => `storyboard[${shotOffset}].${field}`)
  )).flat();
  const offset = (segmentIndex * 7) % candidates.length;
  return rotateValues(candidates, offset).slice(0, patchCount);
}

function buildFullPrompt(segmentIndex, scenario, storyboard, shotCount, targetLength) {
  const header = [
    `第${segmentIndex}段｜${scenario.title}`,
    `核心主题：${scenario.theme}，人物、道具、空间与时间连续。`,
    `总时长${shotCount * 3}秒，16:9横屏，24fps，克制写实，无配乐。`,
  ].join("\n");
  const shots = storyboard.map((shot) => [
    `${shot.timeRange}｜镜头${shot.shotNumber}｜${shot.shotType}`,
    sanitizeSyntheticSafetyMarker(shot.scene),
    sanitizeSyntheticSafetyMarker(shot.visual).slice(0, 58),
    sanitizeSyntheticSafetyMarker(shot.videoPrompt).slice(0, 86),
  ].join("；")).join("\n");
  return fitCompactText(`${header}\n${shots}`, targetLength, segmentIndex * 11);
}

function createSafetyShapeMarkers(kind, count, segmentIndex) {
  return Array.from({ length: count }, (_, markerIndex) => {
    const marker = String(markerIndex + 1).padStart(2, "0");
    return kind === "warning"
      ? `紧张情绪标记${segmentIndex}-${marker}`
      : `未成年人语境标记${segmentIndex}-${marker}`;
  });
}

function sanitizeSyntheticSafetyMarker(value) {
  return String(value || "").replace(/公安局/g, "城市办案建筑");
}

function padResultJsonBytes(result, targetBytes) {
  const currentBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (currentBytes >= targetBytes) return;
  result.editingNotes.push("");
  const withEmptyBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (withEmptyBytes > targetBytes) {
    throw new Error(`Synthetic result padding envelope exceeds byte budget (${withEmptyBytes}/${targetBytes})`);
  }
  const remaining = targetBytes - withEmptyBytes;
  result.editingNotes[result.editingNotes.length - 1] = `${"静".repeat(Math.floor(remaining / 3))}${".".repeat(remaining % 3)}`;
  const finalBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (finalBytes !== targetBytes) {
    throw new Error(`Synthetic result byte budget is not exact (${finalBytes}/${targetBytes})`);
  }
}

function fitCompactText(value, targetLength, seed = 0) {
  let next = String(value || "").trim();
  let fragmentIndex = 0;
  while (compactLength(next) < targetLength) {
    const fragment = SAFE_DETAIL_FRAGMENTS[(seed + fragmentIndex) % SAFE_DETAIL_FRAGMENTS.length];
    next = `${next}${next ? "，" : ""}${fragment}`;
    fragmentIndex += 1;
  }
  return truncateToCompactLength(next, targetLength);
}

function truncateToCompactLength(value, targetLength) {
  let count = 0;
  let result = "";
  for (const character of String(value || "")) {
    const isWhitespace = /\s/.test(character);
    if (!isWhitespace && count >= targetLength) break;
    result += character;
    if (!isWhitespace) count += 1;
  }
  return result.trimEnd();
}

function createDistributionTargets(summary, count) {
  const targets = new Array(count).fill(summary.min);
  const anchors = [
    [0, summary.min],
    [Math.max(0, Math.ceil(count * 0.5) - 1), summary.p50],
    [Math.max(0, Math.ceil(count * 0.95) - 1), summary.p95],
    [Math.max(0, count - 1), summary.max],
  ];
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const [startIndex, startValue] = anchors[anchorIndex];
    const [endIndex, endValue] = anchors[anchorIndex + 1];
    if (endIndex === startIndex) {
      targets[startIndex] = endValue;
      continue;
    }
    for (let index = startIndex; index <= endIndex; index += 1) {
      const ratio = (index - startIndex) / (endIndex - startIndex);
      targets[index] = Math.round(startValue + (endValue - startValue) * ratio);
    }
  }
  return targets;
}

function rotateValues(values, offset) {
  if (!values.length) return [];
  const normalizedOffset = offset % values.length;
  return [...values.slice(normalizedOffset), ...values.slice(0, normalizedOffset)];
}

function assignBudgetsByWeight(budgets, weights) {
  if (budgets.length !== weights.length) {
    throw new Error("Synthetic budget and workload counts must match");
  }
  const sortedBudgets = [...budgets].sort((left, right) => left - right);
  const rankedIndexes = weights
    .map((weight, index) => ({ index, weight }))
    .sort((left, right) => left.weight - right.weight || left.index - right.index);
  const assigned = new Array(budgets.length);
  rankedIndexes.forEach(({ index }, rank) => {
    assigned[index] = sortedBudgets[rank];
  });
  return assigned;
}

function buildShapeDeltas(observed, generated) {
  const checks = [];
  const addCheck = (metric, observedValue, generatedValue, tolerance) => {
    const delta = generatedValue - observedValue;
    const ratio = observedValue === 0 ? (generatedValue === 0 ? 1 : null) : generatedValue / observedValue;
    checks.push({
      metric,
      observed: observedValue,
      generated: generatedValue,
      delta,
      ratio,
      tolerance,
      accepted: observedValue === 0
        ? generatedValue === 0
        : Math.abs(delta) <= Math.max(1, Math.abs(observedValue) * tolerance),
    });
  };
  for (const key of ["min", "p50", "p95", "max"]) {
    addCheck(
      `promptLengthSummary.${key}`,
      observed.promptLengthSummary[key],
      generated.promptLengthSummary[key],
      key === "p50" || key === "p95" ? 0.10 : 0.15,
    );
  }
  for (const key of ["p50", "p95"]) {
    addCheck(`resultByteSummary.${key}`, observed.resultByteSummary[key], generated.resultByteSummary[key], 0.15);
    addCheck(`contractByteSummary.${key}`, observed.contractByteSummary[key], generated.contractByteSummary[key], 0.15);
  }
  for (const key of ["p50", "p95", "max", "total"]) {
    addCheck(`localPatchSummary.${key}`, observed.localPatchSummary[key], generated.localPatchSummary[key], key === "total" ? 0.10 : 0.125);
  }
  for (const severity of ["blocking", "patchable", "warning", "risk"]) {
    for (const key of ["p50", "p95", "max", "total"]) {
      addCheck(
        `findingSummary.${severity}.${key}`,
        observed.findingSummary[severity][key],
        generated.findingSummary[severity][key],
        severity === "blocking" || severity === "patchable" ? 0 : 0.10,
      );
    }
  }
  return checks;
}

function selectActions(actions, shotCount) {
  if (shotCount === 5) return [...actions];
  if (shotCount === 4) return [actions[0], actions[1], actions[2], actions[4]];
  throw new Error(`Unsupported synthetic shot count: ${shotCount}`);
}

function expandHistogram(histogramValue, segmentCount) {
  const result = [];
  for (const [shotCount, count] of Object.entries(histogramValue).sort(([left], [right]) => Number(left) - Number(right))) {
    for (let index = 0; index < count; index += 1) result.push(Number(shotCount));
  }
  if (result.length !== segmentCount) throw new Error("Shot histogram does not match fixture segment count");
  return result;
}

function histogram(values) {
  return values.reduce((result, value) => {
    const key = String(value);
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
  return {
    count: sorted.length,
    total: sorted.reduce((sum, value) => sum + value, 0),
    min: sorted[0] ?? null,
    p50: sorted.length ? quantile(0.5) : null,
    p95: sorted.length ? quantile(0.95) : null,
    max: sorted.at(-1) ?? null,
  };
}

function compactLength(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalJson(value[key])]),
  );
}

function hashText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
