import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  analyzePromptSafetyTree,
  classifyPromptSafetyPath,
} = require("../lib/prompt-safety-policy.ts");
const {
  applyDeterministicQualityPatchWithDiff,
} = require("../lib/batch-segment-quality-gate.ts");

const pathCases = [
  ["storyboard[0].visual", "EXECUTABLE_VISUAL"],
  ["storyboard[0].scene", "EXECUTABLE_VISUAL"],
  ["storyboard[0].composition", "EXECUTABLE_VISUAL"],
  ["storyboard[0].cameraMovement", "EXECUTABLE_VISUAL"],
  ["storyboard[0].lighting", "EXECUTABLE_VISUAL"],
  ["storyboard[0].firstFramePrompt", "EXECUTABLE_VISUAL"],
  ["storyboard[0].videoPrompt", "EXECUTABLE_VISUAL"],
  ["storyboard[0].lastFramePrompt", "EXECUTABLE_VISUAL"],
  ["storyboard[0].shotPurpose", "NARRATIVE_METADATA"],
  ["storyboard[0].sound", "EXECUTABLE_AUDIO_TEXT"],
  ["storyboard[0].dialogue", "EXECUTABLE_AUDIO_TEXT"],
  ["storyboard[0].negativePrompt", "NEGATIVE_CONSTRAINT"],
  ["workflow.fullNegativePrompt", "NEGATIVE_CONSTRAINT"],
  ["workflow.fullVideoPrompt", "CANONICAL_EXECUTABLE"],
  ["workflow.concisePrompt", "ARCHIVE_DERIVED"],
  ["optimizedScript", "NARRATIVE_METADATA"],
  ["workflow.sourceAnalysis", "NARRATIVE_METADATA"],
  ["workflow.screenplay", "ARCHIVE_DERIVED"],
  ["workflow.filmScript", "ARCHIVE_DERIVED"],
];

for (const [path, expected] of pathCases) {
  test(`classifies ${path} as ${expected}`, () => {
    assert.equal(classifyPromptSafetyPath(path), expected);
  });
}

const semanticCases = [
  {
    name: "concrete corpse in executable visual remains blocking",
    path: "storyboard[0].videoPrompt",
    text: "镜头推近尸体面部细节，冷光照亮现场。",
    severity: "blocking",
    polarity: "affirmative",
  },
  {
    name: "negative prompt corpse is locally abstracted",
    path: "storyboard[0].negativePrompt",
    text: "不要尸体特写，不要血泊。",
    severity: "risk",
    polarity: "negative_constraint",
    excludes: /尸体|血泊/,
  },
  {
    name: "negated metadata fact does not request repair",
    path: "optimizedScript",
    text: "法医确认现场没有尸体特写，也未见血泊。",
    severity: "warning",
    polarity: "negated_fact",
  },
  {
    name: "negative canonical clause is not treated as an affirmative shot",
    path: "workflow.fullVideoPrompt",
    text: "画面保持克制，不展示伤口特写，不出现真实警徽。",
    severity: "risk",
    polarity: "negative_constraint",
    excludes: /伤口特写|警徽/,
  },
  {
    name: "concrete national emblem in first frame is locally generalized",
    path: "storyboard[0].firstFramePrompt",
    text: "国徽位于建筑正门上方，人物从门前经过。",
    severity: "risk",
    polarity: "affirmative",
    excludes: /国徽/,
  },
  {
    name: "low-risk suspense remains warning only",
    path: "storyboard[0].emotion",
    text: "悬疑而紧张，人物保持克制。",
    severity: "warning",
    polarity: "affirmative",
  },
  {
    name: "metadata says no real uniform without triggering blocking",
    path: "workflow.sourceAnalysis",
    text: "角色没有穿真实警服，只穿深色普通制服。",
    severity: "warning",
    polarity: "negated_fact",
  },
  {
    name: "executable wound wording is generalized without Codex",
    path: "storyboard[0].visual",
    text: "镜头记录伤口特写，人物后退半步。",
    severity: "risk",
    polarity: "affirmative",
    excludes: /伤口特写/,
  },
  {
    name: "negative audio text keeps its prohibition semantics",
    path: "storyboard[0].dialogue",
    text: "旁白：不要描述血泊，也不要渲染伤口。",
    severity: "risk",
    polarity: "negative_constraint",
    excludes: /血泊/,
  },
  {
    name: "archive copy never becomes an automatic repair target",
    path: "workflow.filmScript",
    text: "旧稿记载现场出现血泊与警徽。",
    severity: "warning",
    polarity: "affirmative",
  },
  {
    name: "explicit self-harm action in executable copy stays blocking",
    path: "storyboard[0].videoPrompt",
    text: "角色准备上吊，镜头展示具体动作。",
    severity: "blocking",
    polarity: "affirmative",
  },
  {
    name: "metadata denial of self-harm stays nonblocking",
    path: "optimizedScript",
    text: "调查结论明确排除自杀，也没有上吊行为。",
    severity: "warning",
    polarity: "negated_fact",
  },
];

for (const item of semanticCases) {
  test(item.name, () => {
    const result = analyzePromptSafetyTree({ value: item.text }, {
      phase: "quality",
      segmentIndex: 3,
      rootPath: item.path.replace(/\.value$/, ""),
    });
    assert.ok(result.findings.length > 0);
    assert.equal(result.findings[0].severity, item.severity);
    assert.equal(result.findings[0].polarity, item.polarity);
    assert.equal(result.findings[0].requiresCodexRepair, item.severity === "blocking");
    if (item.excludes) assert.doesNotMatch(result.value.value, item.excludes);
  });
}

test("one semantic risk copied across canonical and negative fields becomes one primary finding", () => {
  const result = analyzePromptSafetyTree({
    workflow: {
      fullVideoPrompt: "画面不展示伤口特写。",
      fullNegativePrompt: "不要伤口特写。",
    },
    storyboard: [{ negativePrompt: "避免伤口特写。" }],
  }, { phase: "quality", segmentIndex: 8 });

  const woundFindings = result.findings.filter((finding) => finding.ruleId === "wound_closeup");
  assert.equal(woundFindings.length, 1);
  assert.equal(woundFindings[0].affectedPaths.length, 3);
  assert.equal(woundFindings[0].affectedPathCount, 3);
  assert.match(woundFindings[0].fingerprint, /^ps_/);
});

test("mixed affirmative and negative clauses keep the concrete corpse blocking", () => {
  const result = analyzePromptSafetyTree({
    storyboard: [{ videoPrompt: "镜头展示尸体面部细节，但不要出现血泊。" }],
  }, { phase: "quality", segmentIndex: 4 });

  const corpse = result.findings.find((finding) => finding.ruleId === "corpse");
  const bloodPool = result.findings.find((finding) => finding.ruleId === "blood_pool");
  assert.equal(corpse?.polarity, "affirmative");
  assert.equal(corpse?.severity, "blocking");
  assert.equal(bloodPool?.polarity, "negative_constraint");
});

test("negation after a matched concept never changes the earlier affirmative polarity", () => {
  const result = analyzePromptSafetyTree({
    storyboard: [{ videoPrompt: "尸体面部细节清晰呈现，随后说明不要采用这种构图。" }],
  }, { phase: "quality", segmentIndex: 5 });

  const corpse = result.findings.find((finding) => finding.ruleId === "corpse");
  assert.equal(corpse?.polarity, "affirmative");
  assert.equal(corpse?.severity, "blocking");
});

test("contrast words terminate a negative scope before later affirmative content", () => {
  for (const connector of ["但是", "然而", "却", "不过", "随后"]) {
    const result = analyzePromptSafetyTree({
      storyboard: [{ videoPrompt: `不要出现血泊，${connector}镜头展示尸体面部细节。` }],
    }, { phase: "quality", segmentIndex: 6 });
    const corpse = result.findings.find((finding) => finding.ruleId === "corpse");
    assert.equal(corpse?.polarity, "affirmative", connector);
    assert.equal(corpse?.severity, "blocking", connector);
  }
});

test("a long metadata sentence still recognizes 未发现性侵迹象 as a negated fact", () => {
  const result = analyzePromptSafetyTree({
    optimizedScript: "调查人员结合现场记录、访谈内容、时间线和多项检验结果进行复核，最终未发现性侵迹象。",
  }, { phase: "quality", segmentIndex: 7 });
  const finding = result.findings.find((item) => item.ruleId === "sexual_violence");
  assert.equal(finding?.polarity, "negated_fact");
  assert.equal(finding?.requiresCodexRepair, false);
});

test("metadata and archive fields stay byte-for-byte unchanged after local safety analysis", () => {
  const input = {
    optimizedScript: "旧档案明确记录现场出现血泊。",
    storyboard: [{ shotPurpose: "交代尸体线索与调查方向。" }],
    workflow: {
      concisePrompt: "资料摘要写有警徽与伤口特写。",
      filmScript: "旧稿记载真实警服和国徽。",
    },
  };
  const result = analyzePromptSafetyTree(input, { phase: "quality", segmentIndex: 8 });

  assert.deepEqual(result.value.optimizedScript, input.optimizedScript);
  assert.deepEqual(result.value.storyboard[0].shotPurpose, input.storyboard[0].shotPurpose);
  assert.deepEqual(result.value.workflow.concisePrompt, input.workflow.concisePrompt);
  assert.deepEqual(result.value.workflow.filmScript, input.workflow.filmScript);
});

test("deterministic quality patch never rewrites metadata or archive paths", () => {
  const input = {
    optimizedScript: "single-segment AnalysisResult 调试摘要",
    workflow: {
      concisePrompt: "single-segment AnalysisResult 归档摘要",
    },
    storyboard: [{
      shotPurpose: "交代线索",
      videoPrompt: "镜头缓慢推近桌面的聊天记录。",
    }],
  };
  const result = applyDeterministicQualityPatchWithDiff(input, [
    {
      code: "field_below_target",
      severity: "patchable",
      path: "storyboard[0].shotPurpose",
      affectedPaths: ["storyboard[0].shotPurpose"],
      message: "镜头目的偏短",
    },
    {
      code: "internal_token",
      severity: "patchable",
      path: "workflow.concisePrompt",
      affectedPaths: ["workflow.concisePrompt"],
      message: "归档字段包含内部标识",
    },
    {
      code: "field_below_target",
      severity: "patchable",
      path: "storyboard[0].videoPrompt",
      affectedPaths: ["storyboard[0].videoPrompt"],
      message: "视频提示词偏短",
    },
  ]);

  assert.equal(result.result.optimizedScript, input.optimizedScript);
  assert.equal(result.result.workflow.concisePrompt, input.workflow.concisePrompt);
  assert.equal(result.result.storyboard[0].shotPurpose, input.storyboard[0].shotPurpose);
  assert.notEqual(result.result.storyboard[0].videoPrompt, input.storyboard[0].videoPrompt);
  assert.deepEqual(result.patchDiffs.map((diff) => diff.path), ["storyboard[0].videoPrompt"]);
});

test("twenty-segment redacted replay keeps negated facts and negative lists out of Codex repair", () => {
  for (let segmentIndex = 1; segmentIndex <= 20; segmentIndex += 1) {
    const result = analyzePromptSafetyTree({
      optimizedScript: `第${segmentIndex}段核验结论：没有尸体特写，未见血泊，排除自杀。`,
      workflow: {
        fullVideoPrompt: "画面保持克制，不展示伤口特写，不出现真实警徽。",
        fullNegativePrompt: "不要尸体特写，不要血泊，不要真实警服。",
      },
      storyboard: [{
        visual: "人物在普通办公室核对资料，画面不展示伤害细节。",
        negativePrompt: "避免尸体细节、血泊和真实机构徽章。",
      }],
    }, { phase: "quality", segmentIndex });
    assert.equal(result.findings.some((finding) => finding.requiresCodexRepair), false);
  }
});
