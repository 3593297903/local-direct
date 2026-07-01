import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  claimNextPromptSafetyCodexJob,
  completePromptSafetyCodexJob,
  createPromptSafetyCodexJob,
  failPromptSafetyCodexJob,
  getPromptSafetyCodexJob,
} = require("../lib/prompt-safety-codex-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-prompt-safety-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sampleAnalysisResult() {
  return {
    title: "Morning Kitchen",
    contentType: "short drama",
    duration: "15 seconds",
    style: "soft cinematic realism",
    diagnosis: ["quiet domestic scene"],
    optimizedScript: "A woman notices a tense calendar projection in a quiet kitchen.",
    workflow: {
      sourceAnalysis: "A restrained domestic scene.",
      screenplay: "The character reacts to the calendar projection.",
      filmScript: "Five restrained shots preserve the emotional beat.",
      fullVideoPrompt: "A quiet kitchen scene with a tense calendar projection, no graphic content.",
      fullNegativePrompt: "no graphic violence, no gore, no explicit injury",
      concisePrompt: "quiet kitchen, calendar projection, restrained tension",
    },
    storyboard: [
      {
        shotNumber: 1,
        timeRange: "0.0s-3.0s",
        scene: "Kitchen",
        visual: "A clean kitchen table and a floating calendar projection.",
        shotType: "medium shot",
        composition: "eye-level composition with the table in the foreground",
        cameraMovement: "slow push in",
        lighting: "soft morning window light",
        sound: "quiet room tone and a faint device hum",
        dialogue: "No dialogue",
        emotion: "restrained tension",
        transition: "hard cut",
        shotPurpose: "establish the domestic space and pressure symbol",
        firstFramePrompt: "quiet kitchen, morning light",
        videoPrompt: "A woman watches a floating calendar projection in a quiet kitchen.",
        lastFramePrompt: "the calendar projection glows softly",
        negativePrompt: "no graphic violence, no gore",
      },
    ],
    recommendedItems: [],
    editingNotes: [],
  };
}

function sampleSafetyResult() {
  return {
    targetModel: "SEEDANCE_2_0",
    status: "OPTIMIZED",
    riskLevel: "MEDIUM",
    findings: [
      {
        field: "storyboard[0].negativePrompt",
        original: "graphic violence",
        reason: "Graphic wording can reduce generation stability.",
        replacement: "no explicit injury detail",
        severity: "medium",
      },
    ],
    changeSummary: ["Replaced graphic wording with restrained visual alternatives."],
    patches: [],
    optimizedResult: sampleAnalysisResult(),
  };
}

function samplePatchSafetyResult(patches = []) {
  return {
    targetModel: "SEEDANCE_2_0",
    status: "OPTIMIZED",
    riskLevel: "MEDIUM",
    findings: [
      {
        field: patches[0]?.path || "workflow.fullVideoPrompt",
        original: patches[0]?.original || "graphic wording",
        reason: "Risky wording should be rewritten locally without changing the structure.",
        replacement: patches[0]?.replacement || "restrained visual wording",
        severity: "medium",
      },
    ],
    changeSummary: ["Applied local string patches while preserving the original structure."],
    patches,
  };
}

function sampleChineseRiskyAnalysisResult() {
  const result = sampleAnalysisResult();
  result.optimizedScript = "\u5047\u5982\u6211\u662f\u57ce\u7ba1\uff0c\u770b\u89c1\u5988\u5988\u5728\u8857\u8fb9\u5356\u7ea2\u85af\uff0c\u6211\u5c31\u6162\u6162\u8d76\u5979\u8d70\u3002";
  result.workflow.fullVideoPrompt = "\u5988\u5988\u524d\u5929\u88ab\u57ce\u7ba1\u6253\u4f24\uff0c\u5730\u70b9\u5728\u6267\u6cd5\u73b0\u573a\u3002";
  result.storyboard[0].visual = "\u4f5c\u6587\u5199\u7740\uff1a\u5047\u5982\u6211\u662f\u57ce\u7ba1\uff0c\u6211\u5c31\u6162\u6162\u8d76\u5979\u8d70\u3002";
  result.storyboard[0].videoPrompt = "\u7eb8\u6761\u5199\u7740\uff1a\u5988\u5988\u524d\u5929\u88ab\u57ce\u7ba1\u6253\u4f24\u3002";
  result.storyboard[0].lastFramePrompt = "\u6267\u6cd5\u73b0\u573a\u4e4b\u540e\uff0c\u5434\u5148\u751f\u6c89\u9ed8\u3002";
  return result;
}

function sampleRiskyAnalysisResult() {
  const result = sampleAnalysisResult();
  result.optimizedScript = "假如我是城管，看见妈妈在街边卖红薯，我就慢慢赶她走。";
  result.workflow.fullVideoPrompt = "妈妈前天被城管打伤，地点在执法现场。";
  result.storyboard[0].visual = "作文写着：假如我是城管，我就慢慢赶她走。";
  result.storyboard[0].videoPrompt = "请假条写着：妈妈前天被城管打伤。";
  result.storyboard[0].lastFramePrompt = "执法现场之后，吴先生沉默。";
  return result;
}

test("creates, claims, and completes a Seedance prompt safety optimization job", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        targetModel: "SEEDANCE_2_0",
        promptText: "A prompt that may contain risky wording.",
        sourceResult: sampleAnalysisResult(),
      },
      { rootDir },
    );

    assert.equal(job.status, "pending");
    assert.match(job.id, /^prompt-safety-job-/);
    assert.match(job.prompt, /Seedance 2\.0/i);
    assert.match(job.prompt, /compliance rewrite/i);
    assert.match(job.prompt, /word-level replacement pass/i);
    assert.match(job.prompt, /Do not evade moderation/i);
    assert.match(job.prompt, /immutable structure contract/i);
    assert.match(job.prompt, /Do not rewrite sentences/i);
    assert.match(job.prompt, /no compliance explanation, no replacement report, no audit notes/i);
    assert.match(job.prompt, /Write the JSON file as UTF-8/i);
    assert.match(job.prompt, /Do not use PowerShell Set-Content/i);
    assert.match(job.prompt, /strict word-level replacement/i);
    assert.match(job.prompt, /城管 -> 管理员/);
    assert.match(job.prompt, /赶她走 -> 劝她走/);
    assert.match(job.prompt, /被城管打伤 -> 被管理员伤到/);
    assert.match(job.prompt, /执法现场 -> 管理现场/);
    assert.match(job.prompt, /optimizedResult/);
    assert.match(job.outputPath, /tmp-prompt-safety-codex[\\/]results[\\/]prompt-safety-job-/);

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed, "expected a pending prompt safety job");
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, "running");

    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(sampleSafetyResult(), null, 2));

    const completed = await completePromptSafetyCodexJob(claimed.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.status, "OPTIMIZED");
    assert.equal(completed.result.optimizedResult.workflow.fullVideoPrompt.includes("no graphic content"), true);

    const reloaded = await getPromptSafetyCodexJob(job.id, { rootDir });
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.result.optimizedResult.storyboard[0].shotPurpose, "establish the domestic space and pressure symbol");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("keeps source text locked and applies only minimal lexical replacements", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "假如我是城管，看见妈妈在街边卖红薯，我就慢慢赶她走。",
        sourceResult: sampleRiskyAnalysisResult(),
      },
      { rootDir },
    );

    const sourceText = JSON.stringify(job.sourceResult);
    assert.equal(sourceText.includes("城管"), true);
    assert.equal(sourceText.includes("赶她走"), true);
    assert.equal(sourceText.includes("被城管打伤"), true);
    assert.equal(sourceText.includes("执法现场"), true);
    assert.match(job.prompt, /假如我是城管/);

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const codexResult = samplePatchSafetyResult([]);
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(codexResult, null, 2), "utf8");

    const completed = await completePromptSafetyCodexJob(job.id, { rootDir });
    const optimizedText = JSON.stringify(completed.result.optimizedResult);
    assert.equal(optimizedText.includes("城管"), false);
    assert.equal(optimizedText.includes("赶她走"), false);
    assert.equal(optimizedText.includes("被城管打伤"), false);
    assert.equal(optimizedText.includes("执法现场"), false);
    assert.match(optimizedText, /管理员/);
    assert.match(optimizedText, /劝她走/);
    assert.match(optimizedText, /被管理员伤到/);
    assert.match(optimizedText, /管理现场/);
    assert.equal(optimizedText.includes("在街边摊位发生意外后住院"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("applies patch-only Codex output to the locked source structure", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "A prompt to optimize with local patch replacement.",
        sourceResult: sampleAnalysisResult(),
      },
      { rootDir },
    );

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const patchOutput = samplePatchSafetyResult([
      {
        path: "workflow.fullVideoPrompt",
        original: "A quiet kitchen scene",
        replacement: "A calm kitchen scene",
        riskType: "scene_wording",
        strategy: "replace only the risky phrase in the existing field",
      },
      {
        path: "storyboard[0].videoPrompt",
        original: "watches a floating calendar projection",
        replacement: "sees a floating calendar projection",
        riskType: "visual_wording",
        strategy: "preserve shot action and replace only the phrase",
      },
    ]);
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(patchOutput, null, 2), "utf8");

    const completed = await completePromptSafetyCodexJob(job.id, { rootDir });
    const optimized = completed.result.optimizedResult;
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.patches.length, 2);
    assert.equal(optimized.title, job.sourceResult.title);
    assert.equal(optimized.duration, job.sourceResult.duration);
    assert.equal(optimized.style, job.sourceResult.style);
    assert.equal(optimized.storyboard.length, job.sourceResult.storyboard.length);
    assert.equal(optimized.storyboard[0].shotNumber, job.sourceResult.storyboard[0].shotNumber);
    assert.equal(optimized.storyboard[0].timeRange, job.sourceResult.storyboard[0].timeRange);
    assert.equal(optimized.storyboard[0].scene, job.sourceResult.storyboard[0].scene);
    assert.match(optimized.workflow.fullVideoPrompt, /A calm kitchen scene/);
    assert.match(optimized.storyboard[0].videoPrompt, /sees a floating calendar projection/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects expanded prompt safety patches that rewrite instead of replacing words", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "妈妈前天被城管打伤，地点在执法现场。",
        sourceResult: sampleRiskyAnalysisResult(),
      },
      { rootDir },
    );

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const patchOutput = samplePatchSafetyResult([
      {
        path: "workflow.fullVideoPrompt",
        original: "被城管打伤",
        replacement: "在街边摊位发生意外后住院",
        riskType: "over-expanded_rewrite",
        strategy: "this must be rejected because it rewrites the sentence",
      },
    ]);
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(patchOutput, null, 2), "utf8");

    await assert.rejects(
      () => completePromptSafetyCodexJob(job.id, { rootDir }),
      /must stay near the original length/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("applies overlapping lexical patches longest first within the same field", async () => {
  const rootDir = makeTempRoot();
  try {
    const sourceResult = sampleRiskyAnalysisResult();
    sourceResult.optimizedScript = "假如我是城管，妈妈前天被城管打伤，我就慢慢赶她走。";
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "假如我是城管，妈妈前天被城管打伤，我就慢慢赶她走。",
        sourceResult,
      },
      { rootDir },
    );

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const patchOutput = samplePatchSafetyResult([
      {
        path: "optimizedScript",
        original: "城管",
        replacement: "管理员",
        riskType: "identity_word",
        strategy: "shorter patch intentionally appears before the longer phrase",
      },
      {
        path: "optimizedScript",
        original: "赶她走",
        replacement: "劝她走",
        riskType: "action_word",
        strategy: "minimal verb replacement",
      },
      {
        path: "optimizedScript",
        original: "被城管打伤",
        replacement: "被管理员伤到",
        riskType: "injury_phrase",
        strategy: "longer overlapping phrase must apply first",
      },
    ]);
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(patchOutput, null, 2), "utf8");

    const completed = await completePromptSafetyCodexJob(job.id, { rootDir });
    assert.match(completed.result.optimizedResult.optimizedScript, /假如我是管理员/);
    assert.match(completed.result.optimizedResult.optimizedScript, /被管理员伤到/);
    assert.match(completed.result.optimizedResult.optimizedScript, /慢慢劝她走/);
    assert.doesNotMatch(completed.result.optimizedResult.optimizedScript, /被管理员打伤/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("keeps final optimized text clean after patch replacement", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "A prompt to optimize without adding compliance notes.",
        sourceResult: sampleAnalysisResult(),
      },
      { rootDir },
    );

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const patchOutput = samplePatchSafetyResult([
      {
        path: "optimizedScript",
        original: "A woman notices",
        replacement: "\u5408\u89c4\u4f18\u5316\u8bf4\u660e\uff1aA woman notices",
        riskType: "meta_text",
        strategy: "strip meta labels from final prompt text",
      },
      {
        path: "storyboard[0].visual",
        original: "A clean kitchen table",
        replacement: "A clean kitchen table\n\u66ff\u6362\u8bb0\u5f55\uff1aremoved risky words",
        riskType: "meta_text",
        strategy: "remove audit-note lines from final prompt text",
      },
    ]);
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(patchOutput, null, 2), "utf8");

    const completed = await completePromptSafetyCodexJob(job.id, { rootDir });
    const optimizedText = JSON.stringify(completed.result.optimizedResult);
    assert.equal(optimizedText.includes("\u5408\u89c4\u4f18\u5316\u8bf4\u660e"), false);
    assert.equal(optimizedText.includes("\u66ff\u6362\u8bb0\u5f55"), false);
    assert.equal(optimizedText.includes("removed risky words"), false);
    assert.match(completed.result.optimizedResult.optimizedScript, /^A woman notices/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stale running prompt safety jobs can be reclaimed or failed", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "A prompt to optimize for Seedance.",
        sourceResult: sampleAnalysisResult(),
      },
      { rootDir },
    );

    const firstClaim = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(firstClaim);
    assert.equal(firstClaim.status, "running");

    const jobPath = path.join(rootDir, ".tmp-prompt-safety-codex", "jobs", `${job.id}.json`);
    const raw = JSON.parse(readFileSync(jobPath, "utf8"));
    raw.startedAt = new Date(Date.now() - 60_000).toISOString();
    raw.updatedAt = raw.startedAt;
    writeFileSync(jobPath, JSON.stringify(raw, null, 2));

    const reclaimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest", runningTimeoutMs: 1 });
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, job.id);

    const failed = await failPromptSafetyCodexJob(job.id, "codex failed", { rootDir });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "codex failed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("normalizes blank source storyboard time ranges before Codex optimization", async () => {
  const rootDir = makeTempRoot();
  try {
    const sourceResult = sampleAnalysisResult();
    sourceResult.storyboard[0].timeRange = "";
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "A prompt to optimize for Seedance with blank shot timing.",
        sourceResult,
      },
      { rootDir },
    );

    assert.equal(job.sourceResult.storyboard[0].timeRange, "0-15秒");
    assert.match(job.prompt, /"timeRange": "0-15秒"/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects prompt safety output without the required patch array", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "A prompt to optimize.",
        sourceResult: sampleAnalysisResult(),
      },
      { rootDir },
    );

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const incomplete = sampleSafetyResult();
    delete incomplete.patches;
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, `\uFEFF${JSON.stringify(incomplete, null, 2)}`, "utf8");

    await assert.rejects(
      () => completePromptSafetyCodexJob(job.id, { rootDir }),
      /missing patches/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects prompt safety patches outside locked source string fields", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createPromptSafetyCodexJob(
      {
        promptText: "A prompt to optimize without changing its shot structure.",
        sourceResult: sampleAnalysisResult(),
      },
      { rootDir },
    );

    const claimed = await claimNextPromptSafetyCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const changedStructure = samplePatchSafetyResult([
      {
        path: "storyboard[1].visual",
        original: "anything",
        replacement: "safe",
        riskType: "invalid_path",
        strategy: "attempt to patch a shot that does not exist",
      },
    ]);
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(changedStructure, null, 2), "utf8");

    await assert.rejects(
      () => completePromptSafetyCodexJob(job.id, { rootDir }),
      /path must point to a string field/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
