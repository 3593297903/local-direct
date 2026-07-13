import { createHash } from "node:crypto";

const SHOT_ACTIONS = [
  {
    scene: "合成资料室入口与时间线工作台",
    action: "记录员甲进入资料室，将本段编号卡放到时间线起点，并逐张校对蓝色索引卡",
    focus: "编号卡、时间线起点与人物手部动作",
    movement: "摄影机从门框外稳定跟入，随后沿桌面低速横移到编号卡",
  },
  {
    scene: "合成资料室中央的双层证据桌",
    action: "观察员乙把琥珀色校准卡与蓝色索引卡并排摆放，记录员甲核对两组时间标记",
    focus: "双色校准卡、时间标记与人物克制反应",
    movement: "摄影机以中景固定建立空间，再缓慢推进到并排卡片和人物视线交点",
  },
  {
    scene: "合成资料室北侧的投影墙与旋转标尺",
    action: "记录员甲转动透明标尺，使投影墙上的路线节点与本段校准点完整重合",
    focus: "旋转标尺、投影节点与重合后的校准点",
    movement: "摄影机贴近标尺做平稳弧形移动，在节点重合时短暂停住",
  },
  {
    scene: "合成资料室出口旁的归档台与封存盒",
    action: "观察员乙将确认卡装入封存盒，记录员甲写下结论并关闭本段资料夹",
    focus: "封存盒、落笔动作与关闭的资料夹",
    movement: "摄影机从双人中景缓慢下移到归档台，以封存盒扣合动作收束",
  },
];

export function canonicalizeFixture(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function computeFixtureHash(value) {
  return createHash("sha256").update(canonicalizeFixture(value), "utf8").digest("hex");
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

export function createBatchGenerationFixture({ fixtureId, segmentCount }) {
  const contracts = [];
  const renderedResults = [];
  const qualityContext = [];

  for (let index = 1; index <= segmentCount; index += 1) {
    const contract = createContract(index, index === segmentCount);
    const result = createResult(index);
    contracts.push(contract);
    renderedResults.push(result);
    qualityContext.push({
      episodeIndex: index,
      expectedShotCount: 4,
      minFullPromptLength: 900,
    });
  }

  return freezeFixture({
    schemaVersion: 1,
    fixtureId,
    sourceHash: hashText(`local-director-phase-zero:${fixtureId}:synthetic-source-v1`),
    requestedDuration: "15秒以内",
    segmentCount,
    contracts,
    renderedResults,
    qualityContext,
    expected: {
      acceptedSegmentIndexes: Array.from({ length: segmentCount }, (_, index) => index + 1),
      needsReviewSegmentIndexes: [],
      blockingFindingFingerprints: [],
      uniquePatchPaths: ["storyboard[0].scene"],
    },
  });
}

function createContract(segmentIndex, nearBudgetLimit) {
  const sourceText = `合成样本第${segmentIndex}段：记录员甲与观察员乙在虚构资料室完成索引卡校准、路线节点核对和封存确认。`;
  const requiredEvents = [
    `第${segmentIndex}组索引卡完成校准`,
    `记录员甲与观察员乙共同确认封存盒`,
  ];
  const eventSlots = [
    createEventSlot(segmentIndex, "index_calibrated", "索引卡完成校准", ["索引卡", "校准卡"], ["校对", "校准", "重合"]),
  ];
  if (nearBudgetLimit) {
    eventSlots.push(
      createEventSlot(
        segmentIndex,
        "archive_confirmed",
        "两名记录人员共同确认归档封存并保留完整时间线",
        ["记录员甲", "观察员乙", "封存盒", "资料夹"],
        ["共同确认", "装入", "扣合", "关闭", "记录结论", "时间线完整"],
      ),
      createEventSlot(
        segmentIndex,
        "continuity_verified",
        "人物服装、道具方向、空间轴线和十二秒时间顺序保持完整连续，并可按镜头顺序追溯复核",
        ["记录员甲", "观察员乙", "深灰工作外套", "浅灰针织外套", "蓝色索引卡"],
        ["保持连续", "方向一致", "轴线稳定", "时间顺序", "四镜头衔接"],
      ),
    );
  }
  const contractWithoutHash = {
    contractSchemaVersion: 2,
    coveragePolicyVersion: "2026-07-10.1",
    sourceHash: hashText(sourceText),
    segmentIndex,
    title: `第${segmentIndex}段｜合成资料校准`,
    sourceText,
    durationSeconds: 12,
    shotCount: 4,
    requiredEvents,
    requiredEventSlots: eventSlots,
    forbiddenFutureEvents: [`第${segmentIndex + 1}组资料的最终结论`],
    characterLocks: [
      {
        characterId: "recorder-a",
        displayName: "记录员甲",
        factKey: "服装",
        expectedValue: "深灰工作外套",
        mode: "must_not_contradict",
        contradictionSignals: [["亮红礼服"], ["更换制服"]],
        appliesFromSegment: segmentIndex,
        appliesThroughSegment: segmentIndex,
      },
    ],
    characters: [
      { name: "记录员甲", identity: "资料记录员", visualLock: "深灰工作外套", role: "执行校准" },
      { name: "观察员乙", identity: "独立观察员", visualLock: "浅灰针织外套", role: "复核归档" },
    ],
    locations: [
      { name: "合成资料室", identity: "完全虚构的测试空间", visualLock: "冷白顶灯、木质工作台、无真实机构标识" },
    ],
    props: [
      { name: "蓝色索引卡", identity: "合成测试道具", visualLock: "无文字品牌与真实编号" },
      { name: "琥珀色校准卡", identity: "合成测试道具", visualLock: "半透明边缘" },
      { name: "封存盒", identity: "合成测试道具", visualLock: "磨砂灰表面" },
    ],
    requiredShotBeats: SHOT_ACTIONS.map((shot, offset) => ({
      shotNumber: offset + 1,
      timeRange: `${offset * 3}s-${(offset + 1) * 3}s`,
      beat: shot.action,
      visualFocus: shot.focus,
    })),
    safetyPolicy: {
      avoidTerms: ["真实机构标识", "可识别个人资料", "具体伤害细节"],
      rewriteHints: {
        "真实机构标识": "抽象几何标记",
        "可识别个人资料": "虚构编号卡",
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
    contradictionGroups: [["校准失败"], ["资料遗失"]],
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

function createResult(segmentIndex) {
  const storyboard = SHOT_ACTIONS.map((template, offset) => createShot(segmentIndex, offset, template));
  if (segmentIndex === 1) storyboard[0].scene = "合成资料桌";
  const fullVideoPrompt = buildFullPrompt(segmentIndex, storyboard);
  return {
    title: `第${segmentIndex}段｜合成资料校准`,
    contentType: "合成叙事实验短片",
    duration: "12秒",
    style: "克制写实、冷白光、稳定运镜、清晰空间关系",
    diagnosis: segmentIndex === 2
      ? [
          "否定事实样本：合成检查卡明确写明未发现具体伤害迹象。",
          "高风险肯定句样本仅用于元数据分类测试：镜头展示具体伤害细节。",
        ]
      : ["合成样本用于测量字段完整度、格式保留和本地质量处理。"],
    optimizedScript: `记录员甲与观察员乙在合成资料室完成第${segmentIndex}组索引卡校准，四个镜头依次建立空间、核对标记、确认节点并完成封存。`,
    recommendedItems: [],
    editingNotes: ["保持四镜头与十二秒结构；所有名称、地点和编号均为合成测试内容。"],
    workflow: {
      sourceAnalysis: `本段围绕第${segmentIndex}组虚构索引卡展开，重点是可执行动作、清晰因果与稳定空间连续性。`,
      screenplay: `记录员甲放置编号卡，观察员乙并排校准卡，两人核对投影节点后完成封存。`,
      filmScript: fullVideoPrompt,
      concisePrompt: `合成资料室内，两名记录人员完成第${segmentIndex}组索引卡校准与封存。`,
      fullVideoPrompt,
      fullNegativePrompt: segmentIndex === 2
        ? "避免展示具体伤害细节，避免真实机构标识、可识别个人资料、字幕水印、低清画面和人物变形。"
        : "避免真实机构标识、可识别个人资料、字幕水印、低清画面、人物变形、无关道具和跳轴。",
      canonicalHash: hashText(fullVideoPrompt),
    },
    storyboard,
    fixtureSentinel: {
      fixture: "phase-zero-synthetic",
      segmentIndex,
      immutable: true,
    },
  };
}

function createShot(segmentIndex, offset, template) {
  const shotNumber = offset + 1;
  const timeRange = `${offset * 3}s-${(offset + 1) * 3}s`;
  const visual = `${template.action}。第${segmentIndex}组卡片保持清楚可辨但不出现真实文字，记录员甲的深灰外套与观察员乙的浅灰外套在同一轴线上保持连续；背景只保留木质桌面、抽象投影节点和柔和冷白顶灯，所有物件位置都服务于当前动作。`;
  const composition = `${template.focus}位于画面主要视觉区，两名人物分别占据前后景，桌面边缘形成稳定引导线，留出明确动作空间并避免遮挡关键道具。`;
  const lighting = `冷白顶灯提供均匀基础照明，桌面侧灯以柔和暖色勾勒卡片边缘和人物手部，背景亮度压低一级，主体面部与道具均保持自然层次。`;
  const sound = `保留真实室内底噪、衣料轻响、卡片接触木桌的细小声音与人物呼吸；第${shotNumber}镜动作完成时加入一次克制的封存盒或标尺机械声，不使用背景音乐。`;
  const dialogue = shotNumber === 4
    ? `观察员乙低声确认：“第${segmentIndex}组资料已经核对，可以封存。”`
    : `记录员甲简短报出第${segmentIndex}组当前校准步骤，观察员乙用一句确认回应。`;
  const firstFramePrompt = `电影级写实画面，${template.scene}完整可见，${template.focus}处在清晰焦平面，两名人物服装、站位和道具方向与上一镜连续，冷白环境光稳定。`;
  const videoPrompt = `十二秒短片的第${shotNumber}镜，${template.movement}；${visual} 构图保持${template.focus}清楚可读，冷白顶灯与桌面暖色侧光共同塑造真实材质，人物动作克制连贯，声音只保留卡片、脚步、衣料和器械的同期细节。`;
  const lastFramePrompt = `${template.action}完成后的定格瞬间，${template.focus}仍位于清晰焦点，人物视线自然引向下一镜动作方向，背景抽象投影和工作台位置保持连续。`;
  return {
    shotNumber,
    timeRange,
    scene: template.scene,
    visual,
    shotType: shotNumber === 1 ? "中远景" : shotNumber === 4 ? "中近景" : "近景",
    composition,
    cameraMovement: template.movement,
    lighting,
    sound,
    dialogue,
    emotion: "专注、克制并逐步形成确认感",
    transition: shotNumber === 4 ? "以封存盒扣合声收束本段" : "以人物手部动作匹配切入下一镜",
    shotPurpose: `第${shotNumber}镜负责${template.focus}，通过明确动作推进第${segmentIndex}组资料从校对到确认的因果链，并为下一镜保留自然视觉方向。`,
    firstFramePrompt,
    videoPrompt,
    lastFramePrompt,
    negativePrompt: "避免字幕水印、真实品牌、可识别个人资料、低清模糊、过曝、人物变形、多余肢体、无关道具、跳轴和突兀转场。",
  };
}

function buildFullPrompt(segmentIndex, storyboard) {
  const header = [
    `第${segmentIndex}段｜合成资料校准`,
    "核心主题：两名记录人员通过可执行动作完成一次虚构资料校准，保持人物、道具、空间和时间连续。",
    "技术参数：总时长12秒，16:9横屏，24fps，克制写实，冷白环境光与轻微暖色桌面侧光。",
    "声音原则：无配乐，只保留脚步、卡片、衣料、器械和必要对白；所有内容均为合成测试素材。",
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
