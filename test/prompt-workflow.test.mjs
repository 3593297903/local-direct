import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("prompt skill requires document-level video prompt workflow", async () => {
  const skillSource = await readFile(join(process.cwd(), "lib", "prompt-optimizer-skill.ts"), "utf8");

  assert.match(skillSource, /文案分析/);
  assert.match(skillSource, /文案改写成剧本/);
  assert.match(skillSource, /专业电影脚本/);
  assert.match(skillSource, /完整 AI 视频提示词/);
  assert.match(skillSource, /根据文案信息密度、动作数量、情绪节奏和场景复杂度自动设计总时长/);
  assert.match(skillSource, /不能超过 15 秒/);
  assert.match(skillSource, /4-5 个镜头/);
  assert.match(skillSource, /小数点后一位/);
  assert.match(skillSource, /场次类型/);
  assert.match(skillSource, /导演备注/);
  assert.match(skillSource, /摄影备注/);
  assert.match(skillSource, /美术备注/);
  assert.match(skillSource, /声音备注/);
  assert.match(skillSource, /不允许写“如上”/);
  assert.match(skillSource, /白布轮廓/);
  assert.match(skillSource, /担架/);
  assert.match(skillSource, /水迹/);
});

test("real-provider prompt enforces the user's Word-template quality bar", async () => {
  const aiSource = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");

  assert.match(aiSource, /DOCUMENT_TEMPLATE_TASK/);
  assert.match(aiSource, /文案分析 -> 文案到剧本 -> 剧本到专业电影脚本 -> 电影脚本到完整 AI 视频提示词/);
  assert.match(aiSource, /所有展示给用户的视频提示词必须使用中文/);
  assert.match(aiSource, /总时长由系统根据文案信息密度、动作数量、情绪节奏和场景复杂度自动设计/);
  assert.match(aiSource, /最高不超过 15 秒/);
  assert.match(aiSource, /标题、总时长、场次类型、时间、地点、天气、主要人物、段落功能/);
  assert.match(aiSource, /导演备注、摄影备注、美术备注、声音备注/);
  assert.match(aiSource, /格式固定为：核心主题、技术参数、镜头画面 \+ 时间轴 \+ 声音 \/ 台词/);
  assert.match(aiSource, /最终全部提示词汇总必须完整展开所有内容/);
  assert.match(aiSource, /不能写“如上”“见上文”“同上”“略”“占位符”“\{变量名\}”/);
  assert.match(aiSource, /赤脚村民扛铁锨走出人群/);
  assert.match(aiSource, /警员用长杆勾住水草和白布边缘/);
  assert.match(aiSource, /assertNoTemplatePlaceholders/);
  assert.match(aiSource, /normalizeDuration/);
  assert.match(aiSource, /max_tokens: Number\(process\.env\.AI_MAX_TOKENS \|\| 22000\)/);
  assert.match(aiSource, /temperature: 0\.18/);
});

test("video parameter lock asks for contextual line breaks without forced fields", async () => {
  const aiSource = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");

  assert.match(aiSource, /技术参数部分请逐行输出/);
  assert.match(aiSource, /其他技术参数只在原文或 generationDiagnosis 能够判断时输出/);
  assert.match(aiSource, /没有明确依据的内容不要强行补充/);
  assert.match(aiSource, /不要为了填满字段而编造天气、人物、地点、禁忌项/);
});

test("analysis workflow includes a generation diagnosis before prompt generation", async () => {
  const aiSource = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");
  const typesSource = await readFile(join(process.cwd(), "types", "index.ts"), "utf8");

  assert.match(typesSource, /GenerationDiagnosis/);
  for (const field of [
    "genre",
    "emotions",
    "pace",
    "sceneKeywords",
    "characterState",
    "visualFocus",
    "cameraStrategy",
    "soundStrategy",
    "avoid",
  ]) {
    assert.match(typesSource, new RegExp(field));
    assert.match(aiSource, new RegExp(field));
  }

  assert.match(aiSource, /必须先完成 workflow\.generationDiagnosis/);
  assert.match(aiSource, /再根据 generationDiagnosis 生成 workflow\.shotPromptText 和 storyboard/);
  assert.match(aiSource, /总时长、画幅、帧率必须始终输出/);
  assert.match(aiSource, /其他技术参数只在原文或 generationDiagnosis 能够判断时输出/);
});

test("analysis types include full workflow and complete shot fields", async () => {
  const typesSource = await readFile(join(process.cwd(), "types", "index.ts"), "utf8");

  for (const field of [
    "GenerationDiagnosis",
    "PromptWorkflow",
    "generationDiagnosis",
    "sourceAnalysis",
    "coreTheme",
    "videoParameterLock",
    "screenplay",
    "filmScript",
    "fullVideoPrompt",
    "fullNegativePrompt",
    "shotPromptText",
    "editingPlan",
    "finalPromptPackage",
    "timeRange",
    "composition",
    "lighting",
    "sound",
    "dialogue",
    "shotPurpose",
  ]) {
    assert.match(typesSource, new RegExp(field));
  }
});

test("dashboard only exposes the final video generation prompt", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");
  const globalStylesSource = await readFile(join(process.cwd(), "app", "globals.css"), "utf8");

  assert.match(dashboardSource, /生成视频提示词/);
  assert.match(dashboardSource, /workspace-hero-shell/);
  assert.match(dashboardSource, /workspace-orb-field fixed inset-0/);
  assert.match(dashboardSource, /workspace-particle/);
  assert.match(dashboardSource, /title-planet/);
  assert.match(dashboardSource, /workspace-prompt-card/);
  assert.match(dashboardSource, /prompt-mode-pill/);
  assert.match(globalStylesSource, /\.workspace-hero-shell::after\s*\{[\s\S]*position: fixed;[\s\S]*inset: 0;/);
  assert.doesNotMatch(globalStylesSource, /\.workspace-hero-shell::after\s*\{[\s\S]*inset: -12rem -30vw;/);
  assert.doesNotMatch(dashboardSource, /prompt-aspect-pill/);
  assert.doesNotMatch(dashboardSource, /useState\("15秒"\)/);
  assert.doesNotMatch(dashboardSource, /aria-label="内容类型"/);
  assert.doesNotMatch(dashboardSource, /aria-label="风格"/);
  assert.doesNotMatch(dashboardSource, /aria-label="时长"/);
  assert.match(dashboardSource, /requestAnalysis\(script, durationSeconds\)/);
  assert.match(dashboardSource, /视频生成提示词/);
  assert.match(dashboardSource, /核心主题/);
  assert.match(dashboardSource, /技术参数/);
  assert.match(dashboardSource, /镜头画面 \+ 时间轴 \+ 声音 \/ 台词/);
  assert.doesNotMatch(dashboardSource, /第一步：文案/);
  assert.doesNotMatch(dashboardSource, /第二步：剧本/);
  assert.doesNotMatch(dashboardSource, /第三步：电影脚本/);
  assert.doesNotMatch(dashboardSource, /最终全部提示词汇总/);
});

test("local mock keeps decimal storyboard timing and final package support", async () => {
  const mockSource = await readFile(join(process.cwd(), "lib", "mock.ts"), "utf8");

  assert.match(mockSource, /toFixed\(1\)/);
  assert.match(mockSource, /estimateDurationSeconds/);
  assert.match(mockSource, /normalizeMockDuration/);
  assert.match(mockSource, /finalPromptPackage/);
  assert.match(mockSource, /shotPromptText/);
  assert.match(mockSource, /editingPlan/);
});
