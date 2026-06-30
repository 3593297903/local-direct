import { recommendKnowledge } from "@/lib/knowledge";
import { buildNegativePrompt, inferPromptType, splitScriptIntoBeats } from "@/lib/prompt-optimizer-skill";
import { AnalysisResult, StoryboardShot } from "@/types";

const shotTypes = ["大全景", "全景", "中景", "中近景", "近景", "特写"];
const compositions = ["低机位三分构图", "正面稳定构图", "过肩构图", "侧逆光轮廓构图", "俯拍压迫构图", "主体居中留白构图"];
const cameraMoves = ["固定镜头", "缓慢推近", "稳定跟拍", "轻微手持晃动", "缓慢拉远", "横向移镜"];
const transitions = ["硬切", "黑场转场", "动作匹配转场", "淡出至黑", "环境声延续转场", "光影溶解转场"];
const lightingPlans = ["冷色低照度，局部硬光", "自然散射光，低饱和色调", "窗外逆光，室内暗部保留细节", "顶光压迫，背景虚化", "暖冷对比，主体边缘光清晰", "阴影遮挡，画面留白"];
const beatRoles = ["建立环境和时代气质", "交代主体进入场景", "抛出关键线索", "放大人物反应", "留下悬念并衔接下一段", "补充空间关系"];

function makeTitle(script: string, type: string) {
  const clean = script.replace(/\s+/g, "").slice(0, 8);
  if (/旧照片|照片/.test(script)) return "雨夜旧照片";
  if (/宿舍|案发|民警/.test(script)) return "旧宿舍案发现场";
  if (/产品|广告|品牌/.test(script)) return "产品广告视频提示词";
  return `${clean || type}视频提示词`;
}

function parseDurationSeconds(duration: string) {
  const match = duration.match(/\d+(\.\d+)?/);
  const seconds = match ? Number(match[0]) : 15;
  return Math.min(15, Math.max(1, Number.isFinite(seconds) ? seconds : 15));
}

function estimateDurationSeconds(script: string) {
  const compact = script.replace(/\s+/g, "");
  const sentenceCount = script
    .split(/[。！？；;?\n]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;

  if (compact.length <= 45 && sentenceCount <= 2) return 8;
  if (compact.length <= 90 && sentenceCount <= 4) return 10;
  if (compact.length <= 160 && sentenceCount <= 7) return 12;
  if (compact.length <= 260 && sentenceCount <= 10) return 14;
  return 15;
}

function normalizeMockDuration(duration: string | undefined, script: string) {
  const match = String(duration || "").match(/\d+(\.\d+)?/);
  const rawSeconds = match ? Number(match[0]) : estimateDurationSeconds(script);
  const seconds = Math.min(15, Math.max(4, Number.isFinite(rawSeconds) ? rawSeconds : estimateDurationSeconds(script)));
  return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}秒`;
}

function desiredShotCount(duration: string, beatCount: number, script = "") {
  const seconds = parseDurationSeconds(duration || "15秒");
  const compactLength = script.replace(/\s+/g, "").length;
  const maxByDuration = seconds <= 4 ? 2 : seconds <= 6 ? 3 : seconds <= 10 ? 4 : 5;
  const rhythmNeed =
    beatCount <= 1 && compactLength <= 35 ? 1 :
    beatCount <= 2 && compactLength <= 80 ? 2 :
    beatCount <= 4 && compactLength <= 160 ? 3 :
    beatCount <= 6 && compactLength <= 260 ? 4 :
    5;

  return Math.max(1, Math.min(maxByDuration, rhythmNeed));
}

function timeWeights(shotCount: number) {
  if (shotCount === 4) return [3.8, 4.1, 3.2, 3.9];
  if (shotCount === 5) return [2.8, 3.4, 2.7, 3.5, 2.6];
  return Array.from({ length: shotCount }, (_, index) => 1 + ((index % 3) * 0.12));
}

function toTimeRange(index: number, shotCount: number, duration: string) {
  const total = parseDurationSeconds(duration || "15秒");
  const weights = timeWeights(shotCount);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const durations = weights.map((value) => (value / weightTotal) * total);
  const start = durations.slice(0, index).reduce((sum, value) => sum + value, 0);
  const end = index === shotCount - 1 ? total : start + durations[index];
  const format = (value: number) => `${(Math.round(value * 10) / 10).toFixed(1)}s`;
  return `${format(start)}-${format(end)}`;
}

function expandBeats(beats: string[], source: string, count: number) {
  const cleanSource = source.trim();
  const base = beats.length ? beats : [cleanSource || "建立主体、场景和核心线索"];
  const expanded: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const text = base[index % base.length];
    expanded.push(`${beatRoles[index % beatRoles.length]}：${text}`);
  }

  return expanded;
}

function pickDialogue(index: number, type: string) {
  if (/悬疑|刑侦|惊悚|犯罪/.test(type)) {
    return index === 0 ? "无，依靠环境声建立压迫感" : index === 2 ? "一句压低声音的短台词，控制在8个字以内" : "无或极短低声反应";
  }
  return index === 0 ? "无，先用画面建立信息" : "如需要台词，只保留一句短句";
}

function buildShot(beat: string, index: number, shotCount: number, duration: string, type: string, style: string): StoryboardShot {
  const shotType = shotTypes[index % shotTypes.length];
  const composition = compositions[index % compositions.length];
  const cameraMovement = cameraMoves[index % cameraMoves.length];
  const transition = transitions[index % transitions.length];
  const lighting = lightingPlans[index % lightingPlans.length];
  const emotion = /悬疑|刑侦|惊悚|犯罪/.test(type) ? "克制、紧张、不安" : "真实、清晰、有节奏";
  const sound = /悬疑|刑侦|惊悚|犯罪/.test(type)
    ? "环境底噪、远处雨声、脚步声、轻微呼吸声，音乐压低"
    : "真实环境声、动作声，音乐轻微托底";
  const dialogue = pickDialogue(index, type);
  const shotPurpose = index === 0 ? "建立空间、时代和情绪基调" : index === 1 ? "交代主体动作和关键线索" : index === shotCount - 1 ? "留下情绪落点或悬念，衔接下一段" : "推进信息并控制节奏";
  const negativePrompt = buildNegativePrompt(type);

  return {
    shotNumber: index + 1,
    timeRange: toTimeRange(index, shotCount, duration),
    scene: beat.slice(0, 32),
    visual: `${beat}。画面只保留一个核心动作，主体、环境、线索关系清楚，不把多个事件挤进同一个镜头。`,
    shotType,
    composition,
    cameraMovement,
    lighting,
    sound,
    dialogue,
    emotion,
    transition,
    shotPurpose,
    firstFramePrompt: `${style}，${shotType}首帧，${composition}，主体位置明确，场景方向清楚，${lighting}，无文字无水印。`,
    videoPrompt:
      `${style}，${shotType}，${composition}，${cameraMovement}，${lighting}。画面内容：${beat}。` +
      `镜头运动要克制稳定，运动服务叙事，不要炫技。声音建议：${sound}。台词：${dialogue}。` +
      `人物表演保持${emotion}，动作节奏自然，镜头目的：${shotPurpose}。结尾使用${transition}衔接下一镜。` +
      `不要字幕，不要水印，保持人物服装、空间方向、色调和光源连续。`,
    lastFramePrompt: `尾帧停在可衔接下一镜的状态：主体动作结束但情绪未完全释放，画面保留${transition}的视觉空间，光影和色调保持一致。`,
    negativePrompt,
    concisePrompt: `${style}，${shotType}，${cameraMovement}，${beat}，${lighting}，${emotion}，${transition}。`,
  };
}

function buildShotLines(storyboard: StoryboardShot[]) {
  return storyboard
    .map(
      (shot) =>
        `${shot.timeRange}｜镜头${shot.shotNumber}｜${shot.shotType} / ${shot.cameraMovement}｜${shot.visual}\n` +
        `声音：${shot.sound || "真实环境声"}｜台词：${shot.dialogue || "无"}｜作用：${shot.shotPurpose || "-"}`
    )
    .join("\n");
}

function buildWorkflow(
  input: {
    script: string;
    contentType: string;
    style: string;
    duration: string;
  },
  type: string,
  storyboard: StoryboardShot[]
) {
  const style = input.style || "电影感写实";
  const duration = normalizeMockDuration(input.duration, input.script);
  const source = input.script.trim();
  const shotLines = buildShotLines(storyboard);
  const shotPromptText = storyboard
    .map(
      (shot) =>
        `镜头 ${shot.shotNumber} 提示词｜${shot.timeRange}
${shot.shotType} / ${shot.cameraMovement} / ${shot.scene}
${shot.videoPrompt}

镜头运动：
${shot.cameraMovement}，${shot.composition || "主体明确构图"}，运动速度要贴合${shot.timeRange}，不要突然加速或晃动。

画面重点：
${shot.visual}

声音建议：
${shot.sound || "真实环境声"}。台词：${shot.dialogue || "无"}。

负面提示词：
${shot.negativePrompt}`
    )
    .join("\n\n");
  const fullNegativePrompt = buildNegativePrompt(type);
  const generationDiagnosis = {
    genre: type,
    emotions: /悬疑|刑侦|惊悚|犯罪/.test(type) ? ["克制", "紧张", "不安"] : ["真实", "清晰"],
    pace: duration.includes("8") || duration.includes("10") ? "中速" : "缓慢推进",
    sceneKeywords: [input.contentType || type].filter(Boolean),
    characterState: /悬疑|刑侦|惊悚|犯罪/.test(type) ? "克制观察，逐步接近线索" : "按原文动作自然推进",
    visualFocus: storyboard.slice(0, 3).map((shot) => shot.scene),
    cameraStrategy: "根据文案节拍组合固定镜头、缓慢推进、跟拍和特写，不按固定秒数机械拆分。",
    soundStrategy: "以真实环境声、动作声和必要短台词为主，音乐只做低音氛围。",
    avoid: ["字幕", "水印", "无关角色", "无依据的地点天气", ...(/悬疑|刑侦|惊悚|犯罪/.test(type) ? ["血腥", "鬼脸", "jump scare"] : [])],
  };
  const coreTheme = `核心主题：把原文案“${source.slice(0, 120)}${source.length > 120 ? "..." : ""}”改编成一段${duration}的${type}视频。重点不是压缩剧情，而是用${storyboard.length}个镜头依次建立环境、主体动作、关键线索、人物反应和悬念落点。`;
  const videoParameterLock =
    `视频参数锁定：
总时长：${duration}
画幅：16:9 横屏
风格：${style}，低饱和，真实自然光，电影感，避免广告感和过度戏剧化
场景：严格来自原文案，不加入无关现代空间
人物：保持同一人物外观、服装、年龄和情绪连续
运镜原则：按${duration}拆成${storyboard.length}个镜头，时间轴精确到小数点后一位，固定、慢推、跟拍、特写交替使用
声音原则：环境声、动作声、短台词优先，音乐只做低音氛围`;
  const fullVideoPrompt =
    `完整视频总提示词：
生成一支${duration}的${type} AI 视频，整体风格为${style}。根据原文案改编：${source}。画面从环境和空间压力开始，逐步进入人物动作和关键线索，再用人物反应或悬念动作收束。全片采用低饱和电影质感，真实自然光，镜头语言克制，画面强调主体、空间、动作和线索的因果关系。按${duration}拆成${storyboard.length}个镜头，不把所有动作挤进一个镜头。镜头之间用硬切、黑场、动作匹配或环境声延续衔接，声音以环境声、脚步声、雨声、呼吸声、纸张声、门轴声等真实声音为主，台词短而克制。完整分镜如下：
${shotLines}`;
  const editingPlan =
    `剪辑建议：
镜头1先建立空间和氛围，中段镜头交代主体动作与关键线索，最后一个镜头放大人物反应或留下悬念。镜头之间不要使用花哨特效，优先使用动作方向、视线方向、环境声和黑场完成衔接。声音从环境底噪逐渐压近，关键线索出现时压低音乐，保留半拍沉默。`;
  const concisePrompt =
    `最适合直接输入视频模型的精简版提示词：
${style}，${type}，${duration}，按${storyboard.length}个镜头分段生成。根据原文案：${source.slice(0, 220)}。环境建立、主体动作、关键线索、人物反应、悬念落点依次推进。主体连续，光影克制，环境声真实，禁止字幕、水印、人物变形和无关现代元素。`;
  const finalPromptPackage =
    `最终全部提示词汇总

${coreTheme}

${videoParameterLock}

${fullVideoPrompt}

负面提示词：
${fullNegativePrompt}

镜头画面 + 时间轴 + 声音 / 台词
${shotLines}

${shotPromptText}

${editingPlan}

${concisePrompt}`;

  return {
    sourceAnalysis:
      `原文案属于${type}。核心内容是：${source}。改编重点是先锁定人物、地点和关键线索，再把抽象情绪转成可见的空间压力、动作细节、光影方向和环境声音。`,
    generationDiagnosis,
    coreTheme,
    videoParameterLock,
    screenplay:
      `剧本化结果：全集影调锁定为${style}，16:9横屏，写实电影质感，低饱和，真实自然光。本段不是把文案压成一句话，而是拆成“环境建立 → 主体动作 → 关键线索 → 人物反应 → 悬念落点”的视频段落。人物锁定：人物外观、服装、年龄、情绪状态保持连续。空间锁定：场景必须来自原文案，空间方向和光源方向保持一致。禁止项：不加入无关角色，不出现字幕、水印、logo，不使用现代广告感，不夸张表演，不让镜头同时做过多动作。`,
    filmScript:
      `镜头画面 + 时间轴 + 声音 / 台词
${shotLines}

导演说明：镜头之间保持空间方向一致，声音以环境声和动作声为主，台词少用，依靠画面、停顿和剪辑推进。`,
    fullVideoPrompt,
    fullNegativePrompt,
    shotPromptText,
    editingPlan,
    concisePrompt,
    finalPromptPackage,
  };
}

export function buildMockAnalysis(input: {
  script: string;
  contentType: string;
  style: string;
  duration: string;
}): AnalysisResult {
  const type = inferPromptType(input.script, input.contentType || "小说剧情类");
  const duration = normalizeMockDuration(input.duration, input.script);
  const beats = splitScriptIntoBeats(input.script);
  const shotCount = desiredShotCount(duration, beats.length, input.script);
  const selectedBeats = expandBeats(beats, input.script, shotCount).slice(0, shotCount);
  const storyboard = selectedBeats.map((beat, index) => buildShot(beat, index, selectedBeats.length, duration, type, input.style || "电影感写实"));
  const workflow = buildWorkflow({ ...input, duration }, type, storyboard);
  const recommended = recommendKnowledge(input.script).map((item) => item.name);

  return {
    title: makeTitle(input.script, type),
    contentType: type,
    duration,
    style: input.style || "电影感写实",
    diagnosis: [
      `文案判断：这是${type}，不能直接塞进一个镜头生成，需要先剧本化，再拆成镜头脚本。`,
      "主要问题：原文案通常只有情节信息，缺少景别、构图、运镜、光影、声音、台词和转场控制。",
      "改编策略：保留核心事件，把情绪转成可见动作和空间压力，每个镜头只表现一个核心信息。",
    ],
    optimizedScript: workflow.fullVideoPrompt,
    workflow,
    storyboard,
    recommendedItems: [
      "文案先剧本化，再拆分镜头生成",
      `按${duration}拆成${storyboard.length}个镜头，本次时间轴按剧情节奏分配到一位小数`,
      "优先使用首帧控制人物和空间连续性",
      ...recommended.slice(0, 4),
    ],
    editingNotes: [
      "生成顺序：先生成每个镜头，再按电影脚本顺序剪辑。",
      "声音设计：雨声、脚步、呼吸、纸张、门轴等环境声比强音乐更稳定。",
      "容易翻车：人物年龄和五官不连续，建议用同一角色参考图或首帧锁定。",
      `完整负面提示词：${workflow.fullNegativePrompt}`,
    ],
  };
}
