import { createHash } from "node:crypto";

import { SYNTHETIC_SCENARIOS } from "./synthetic-scenarios.mjs";

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
  const contracts = [];
  const renderedResults = [];
  const qualityContext = [];

  for (let index = 1; index <= segmentCount; index += 1) {
    const scenario = scenarios[(index - 1) % scenarios.length];
    const shotCount = shotCounts[index - 1];
    const contract = createContract(index, scenario, shotCount, index === segmentCount);
    const result = createResult(index, scenario, shotCount);
    contracts.push(contract);
    renderedResults.push(result);
    qualityContext.push({
      episodeIndex: index,
      expectedShotCount: shotCount,
      minFullPromptLength: 900,
    });
  }

  return freezeFixture({
    schemaVersion: 1,
    fixtureId,
    sourceHash: hashText(`local-director-phase-zero:${fixtureId}:synthetic-source-v2`),
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
      uniquePatchPaths: [
        "storyboard[0].negativePrompt",
        "workflow.fullNegativePrompt",
        "workflow.fullVideoPrompt",
      ],
      adapterVersion: "frozen-dashboard-local-v1",
      productionSourceFingerprint: "pending-phase-0r-b",
    },
  });
}

export function createFixtureManifest(fixture, shapeProfile, contractByteSummary) {
  const promptLengths = fixture.renderedResults.map((result) => compactLength(result.workflow.fullVideoPrompt));
  const scenarioIds = new Set(fixture.renderedResults.map((result) => result.fixtureSentinel.scenarioId));
  const shotCountHistogram = histogram(fixture.renderedResults.map((result) => result.storyboard.length));
  const totalSlots = fixture.contracts.reduce((total, contract) => total + contract.requiredEventSlots.length, 0);
  const anchorGroupCounts = fixture.contracts.flatMap((contract) =>
    contract.requiredEventSlots.map((slot) => slot.anchorGroups.length));
  const conceptGroupCounts = fixture.contracts.flatMap((contract) =>
    contract.requiredEventSlots.map((slot) => slot.conceptGroups.length));
  const repairTargetCounts = fixture.contracts.flatMap((contract) =>
    contract.requiredEventSlots.map((slot) => slot.repairTargets.length));

  return freezeFixture({
    fixtureSchemaVersion: 1,
    fixtureId: fixture.fixtureId,
    sourceShapeHash: shapeProfile.sourceShapeHash,
    segmentCount: fixture.segmentCount,
    scenarioCount: scenarioIds.size,
    shotCountHistogram,
    promptLengthSummary: summarize(promptLengths),
    contractByteSummary,
    safetyPolarityCounts: {
      negatedFact: fixture.renderedResults.filter((result) =>
        canonicalizeFixture(result.diagnosis).includes("未发现性侵迹象")).length,
      negativeConstraint: fixture.renderedResults.filter((result) =>
        result.workflow.fullNegativePrompt.includes("避免尸体画面")).length,
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
    expectedLocalPatchOperations: fixture.expected.uniquePatchPaths.length,
    expectedUniquePatchPaths: fixture.expected.uniquePatchPaths,
    observedShapeProfile: shapeProfile.observedFindingShape,
  });
}

function createContract(segmentIndex, scenario, shotCount, nearBudgetLimit) {
  const selectedActions = selectActions(scenario.actions, shotCount);
  const [firstPerson, secondPerson] = scenario.people;
  const [firstWardrobe, secondWardrobe] = scenario.wardrobe;
  const [primaryProp, secondaryProp, closingProp] = scenario.props;
  const sourceText = `完全合成样本第${segmentIndex}段：${scenario.theme}，按镜头顺序完成建立、核对、确认和收束。`;
  const requiredEventSlots = [
    createEventSlot(
      segmentIndex,
      "primary_action",
      `${primaryProp}完成本段核心核对动作`,
      [primaryProp, firstPerson],
      selectedActions.slice(0, 3).map((action) => action[1].slice(0, 8)),
    ),
  ];
  if (nearBudgetLimit) {
    requiredEventSlots.push(
      createEventSlot(
        segmentIndex,
        "joint_close",
        `${firstPerson}与${secondPerson}共同确认${closingProp}归位`,
        [firstPerson, secondPerson, closingProp],
        ["共同确认", "归位", "扣合", "关闭", "完成"],
      ),
      createEventSlot(
        segmentIndex,
        "continuity_verified",
        "人物服装、道具方向、空间轴线与十五秒内的动作顺序保持连续",
        [firstPerson, secondPerson, firstWardrobe, secondWardrobe, primaryProp],
        ["保持连续", "方向一致", "轴线稳定", "动作顺序", `${shotCount}镜头衔接`],
      ),
    );
  }
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

function createEventSlot(segmentIndex, suffix, label, anchors, concepts) {
  return {
    id: `segment_${String(segmentIndex).padStart(3, "0")}_${suffix}`,
    label,
    importance: "blocking",
    anchorGroups: anchors.map((anchor) => [anchor]),
    conceptGroups: concepts.map((concept) => [concept]),
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
    ],
  };
}

function createResult(segmentIndex, scenario, shotCount) {
  const storyboard = selectActions(scenario.actions, shotCount)
    .map((action, offset) => createShot(segmentIndex, scenario, offset, action, shotCount));
  const fullVideoPrompt = buildFullPrompt(segmentIndex, scenario, storyboard, shotCount);
  return {
    title: `第${segmentIndex}段｜${scenario.title}`,
    contentType: "完全合成叙事实验短片",
    duration: `${shotCount * 3}秒`,
    style: `克制写实、${scenario.lighting}、稳定运镜、清晰空间关系`,
    diagnosis: segmentIndex === 2
      ? [
          "否定事实分类样本：资料核验未发现性侵迹象，本句只表示检查结论。",
          "所有角色、地点、道具与事件均为完全合成的回归测试内容。",
        ]
      : ["合成样本用于测量字段完整度、格式保留和本地质量处理。"],
    optimizedScript: `${scenario.people.join("与")}在${scenario.location}完成第${segmentIndex}段任务，镜头依次建立空间、推进动作、核对状态并完成收束。`,
    recommendedItems: [],
    editingNotes: [`保持${shotCount}镜头与${shotCount * 3}秒结构；所有名称、地点和编号均为合成测试内容。`],
    workflow: {
      sourceAnalysis: `本段围绕${scenario.theme}展开，重点是可执行动作、清晰因果与稳定空间连续性。`,
      screenplay: storyboard.map((shot) => shot.visual.split("。")[0]).join("；"),
      filmScript: fullVideoPrompt,
      concisePrompt: `${scenario.location}内，${scenario.people.join("与")}完成${scenario.title}。`,
      fullVideoPrompt,
      fullNegativePrompt: segmentIndex === 3
        ? "避免尸体画面，避免真实机构标识、可识别个人资料、字幕水印、低清画面和人物变形。"
        : "避免真实机构标识、可识别个人资料、字幕水印、低清画面、人物变形、无关道具和跳轴。",
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
}

function createShot(segmentIndex, scenario, offset, action, shotCount) {
  const [scene, actionText, focus, movement] = action;
  const resolvedScene = `${scenario.location}${scene}工作区`;
  const shotNumber = offset + 1;
  const timeRange = `${offset * 3}s-${(offset + 1) * 3}s`;
  const [firstPerson, secondPerson] = scenario.people;
  const [firstWardrobe, secondWardrobe] = scenario.wardrobe;
  const visual = `${actionText}。第${segmentIndex}段的${scenario.props.join("、")}保持清楚但不出现真实文字；${firstPerson}的${firstWardrobe}与${secondPerson}的${secondWardrobe}沿稳定轴线连续出现，背景仅保留${scenario.location}所需的工作表面、抽象标记和自然材质。`;
  const composition = `${focus}处在主要视觉区，两名人物分别占据前后景，环境边缘形成清晰引导线，保留完整动作空间并避免关键道具互相遮挡。`;
  const lighting = `${scenario.lighting}提供稳定基础层次，局部侧光勾勒道具边缘与人物手部，背景亮度压低一级，面部、服装和材质保持自然不过曝。`;
  const sound = `保留${scenario.ambient}；第${shotNumber}镜动作完成时加入一次与当前道具对应的克制同期声，不使用背景音乐，不添加解释性旁白。`;
  const dialogue = shotNumber === shotCount
    ? `${secondPerson}低声确认：“第${segmentIndex}段已经核对，可以完成收束。”`
    : `${firstPerson}简短说明当前动作，${secondPerson}用一句确认回应。`;
  const firstFramePrompt = `电影级写实画面，${resolvedScene}完整可见，${focus}处于清晰焦平面，两名人物服装、站位和道具方向与上一镜连续，${scenario.lighting}保持稳定。`;
  const videoPrompt = `${shotCount * 3}秒短片的第${shotNumber}镜，${movement}；${visual} 构图让${focus}清楚可辨，${scenario.lighting}共同塑造真实材质，人物动作克制连贯，声音只保留${scenario.ambient}等同期细节。`;
  const lastFramePrompt = `${actionText}完成后的定格瞬间，${focus}仍处于清晰焦点，人物视线自然指向下一镜动作方向，${scenario.location}的空间和道具位置保持连续。`;
  return {
    shotNumber,
    timeRange,
    scene: resolvedScene,
    visual,
    shotType: shotNumber === 1 ? "中远景" : shotNumber === shotCount ? "中近景" : "近景",
    composition,
    cameraMovement: movement,
    lighting,
    sound,
    dialogue,
    emotion: "专注、克制并逐步形成确认感",
    transition: shotNumber === shotCount ? "以当前收束动作和同期声结束本段" : "以人物手部动作匹配切入下一镜",
    shotPurpose: `第${shotNumber}镜负责呈现${focus}，通过明确动作推进${scenario.title}的因果链，并为下一镜保留自然视觉方向。`,
    firstFramePrompt,
    videoPrompt,
    lastFramePrompt,
    negativePrompt: segmentIndex === 3 && shotNumber === 1
      ? "避免尸体画面，避免字幕水印、真实品牌、可识别个人资料、低清模糊、过曝、人物变形、多余肢体、无关道具和跳轴。"
      : "避免字幕水印、真实品牌、可识别个人资料、低清模糊、过曝、人物变形、多余肢体、无关道具、跳轴和突兀转场。",
  };
}

function buildFullPrompt(segmentIndex, scenario, storyboard, shotCount) {
  const header = [
    `第${segmentIndex}段｜${scenario.title}`,
    `核心主题：${scenario.theme}，保持人物、道具、空间与时间连续。`,
    `技术参数：总时长${shotCount * 3}秒，16:9横屏，24fps，克制写实，${scenario.lighting}。`,
    `声音原则：无配乐，只保留${scenario.ambient}与必要对白；所有内容均为合成测试素材。`,
  ].join("\n");
  const shots = storyboard.map((shot) => [
    `${shot.timeRange}｜镜头${shot.shotNumber}｜${shot.shotType}`,
    `场景：${shot.scene}`,
    `画面：${shot.visual}`,
    `构图：${shot.composition}`,
    `运镜：${shot.cameraMovement}`,
    `光影：${shot.lighting}`,
    `声音：${shot.sound}`,
    `台词：${shot.dialogue}`,
    `情绪：${shot.emotion}`,
    `转场：${shot.transition}`,
    `镜头目的：${shot.shotPurpose}`,
    `首帧：${shot.firstFramePrompt}`,
    `视频提示词：${shot.videoPrompt}`,
    `尾帧：${shot.lastFramePrompt}`,
    `负面提示词：${shot.negativePrompt}`,
  ].join("\n")).join("\n\n");
  return `${header}\n\n${shots}`;
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
