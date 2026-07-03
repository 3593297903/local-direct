import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  claimNextSeasonPackCodexJob,
  completeSeasonPackCodexJob,
  createSeasonPackCodexJob,
  getSeasonPackCodexJob,
} = require("../lib/season-pack-codex-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-season-pack-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sampleEpisodeInput(index, overrides = {}) {
  return {
    episodeIndex: index,
    title: `第${index}段｜测试`,
    sourceText: `第${index}段原文案：人物在具体空间里推进关键事件。`,
    duration: "15秒",
    contentType: "短剧 / 悬疑",
    style: "电影级写实",
    storyBible: {
      projectTitle: "测试项目",
      characters: [{ id: "CHAR_01", name: "主角" }],
      visualStyle: "冷静克制，真实光源",
    },
    episodeChain: {
      episodeIndex: index,
      startState: "承接上一集结尾。",
      endState: "留下下一集钩子。",
      nextBridge: "继续推进线索。",
    },
    blueprint: {
      purpose: "推进本集核心事件。",
      keyEvents: ["空间建立", "动作推进", "情绪转折", "段尾钩子"],
    },
    shotCount: 4,
    renderInputScript: `第${index}段单段渲染输入：按单集质量生成完整 AnalysisResult，严格输出 4 个镜头。`,
    ...overrides,
  };
}

function sampleFinalAnalysisResult(index) {
  return {
    title: `Episode ${index}`,
    contentType: "short drama",
    duration: "15 seconds",
    style: "cinematic realism",
    optimizedScript: `Episode ${index} optimized script.`,
    workflow: {
      fullVideoPrompt: `Episode ${index} full video prompt.`,
      fullNegativePrompt: "no gore, no text errors",
    },
    storyboard: [
      {
        shotNumber: 1,
        timeRange: "0.0s-3.0s",
        scene: "scene",
        visual: "visual",
        shotType: "medium shot",
        composition: "composition",
        cameraMovement: "push",
        lighting: "light",
        sound: "sound",
        dialogue: "none",
        emotion: "restrained",
        transition: "cut",
        shotPurpose: "purpose",
        firstFramePrompt: "first",
        videoPrompt: "video",
        lastFramePrompt: "last",
        negativePrompt: "negative",
      },
    ],
  };
}

function structuredSourceWithFourShots() {
  return [
    "集名：《大雨的夜里》",
    "类型：中式现实刑侦惊悚片 / 悲剧收束",
    "第1段｜七天期限后的第一夜",
    "0s-4s｜镜头1｜旧电视机发布会回放",
    "画面内容：昏暗客厅里，旧电视机正在重播发布会。",
    "4s-8s｜镜头2｜少年握紧纸团",
    "画面内容：少年坐在沙发边，纸团被他攥皱。",
    "8s-11s｜镜头3｜父亲拿起钥匙",
    "画面内容：父亲沉默起身，钥匙在手里响了一下。",
    "11s-13s｜镜头4｜雨声压住对白",
    "画面内容：窗外雨线压暗玻璃，屋内无人说话。",
  ].join("\n");
}

test("creates, claims, and completes a season planning job from per-episode input packs", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        script: "Episode 1: A child enters a classroom.\nEpisode 2: The teacher finds a note.",
        episodeCount: 2,
        duration: "auto",
      },
      { rootDir },
    );

    assert.equal(job.status, "pending");
    assert.equal(job.episodeCount, 2);
    assert.match(job.id, /^season-pack-job-/);
    assert.match(job.prompt, /Episode Input Pack/);
    assert.doesNotMatch(job.prompt, /Each AnalysisResult must include/);
    assert.match(job.packDir, /\.tmp-season-pack-codex[\\/]packs[\\/]season-pack-job-/);
    assert.equal(job.result, null);

    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, "running");

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(claimed.manifestPath, JSON.stringify({ episodeCount: 2, generatedEpisodes: [1, 2] }, null, 2), "utf8");
    writeFileSync(claimed.seasonPlanPath, JSON.stringify({ storyBible: { title: "测试" }, episodeChain: [{ index: 1 }, { index: 2 }] }, null, 2), "utf8");
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleEpisodeInput(1), null, 2), "utf8");
    writeFileSync(path.join(claimed.episodesDir, "episode-002.json"), JSON.stringify(sampleEpisodeInput(2), null, 2), "utf8");

    const completed = await completeSeasonPackCodexJob(claimed.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.episodes.length, 2);
    assert.equal(completed.result.episodes[0].episodeIndex, 1);
    assert.match(completed.result.episodes[1].input.renderInputScript, /单集渲染输入/);

    const reloaded = await getSeasonPackCodexJob(job.id, { rootDir });
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.result.episodes[0].input.title, "第1段｜测试");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fills episode input metadata and render script from structured source", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        script: structuredSourceWithFourShots(),
        episodeCount: 1,
        duration: "auto",
        contentType: "short drama / general",
        style: "auto match script tone",
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const input = sampleEpisodeInput(1, {
      title: "",
      sourceText: "",
      duration: "",
      contentType: "",
      style: "",
      shotCount: 4,
      renderInputScript: "",
    });

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(input, null, 2), "utf8");

    const completed = await completeSeasonPackCodexJob(job.id, { rootDir });
    const episode = completed.result.episodes[0].input;
    assert.equal(episode.title, "第1段｜七天期限后的第一夜");
    assert.equal(episode.duration, "13秒");
    assert.equal(episode.contentType, "短剧 / 刑侦惊悚");
    assert.equal(episode.style, "中式现实刑侦惊悚片 / 悲剧收束");
    assert.equal(episode.shotCount, 4);
    assert.match(episode.renderInputScript, /镜头数量锁：4 个镜头/);
    assert.match(episode.renderInputScript, /本段原文案/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects season pack output that still writes final AnalysisResult JSON", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        script: "第1集：测试。会议室内，人物通过线索推进案件。",
        episodeCount: 1,
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleFinalAnalysisResult(1), null, 2), "utf8");

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /Episode Input Pack, not a final AnalysisResult/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects season planning that compresses explicit source shot count", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        script: structuredSourceWithFourShots(),
        episodeCount: 1,
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleEpisodeInput(1, { shotCount: 3 }), null, 2), "utf8");

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /shotCount 3 does not match source segment shot count 4/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("recognizes colon episode headings and timecode shot lines before validating shot count", async () => {
  const rootDir = makeTempRoot();
  try {
    const source = [
      "第1集：被忘记的角落",
      "00:00-00:03｜镜头1｜草叶微距",
      "00:03-00:06｜镜头2｜路沿石缝",
      "00:06-00:10｜镜头3｜蚂蚁穿过尘土",
      "00:10-00:15｜镜头4｜城市远声压入",
    ].join("\n");
    const job = await createSeasonPackCodexJob({ script: source, episodeCount: 1 }, { rootDir });
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleEpisodeInput(1, { shotCount: 2 }), null, 2), "utf8");

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /shotCount 2 does not match source segment shot count 4/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("caps short source segments at five planned shots unless dense mode exists", async () => {
  const rootDir = makeTempRoot();
  try {
    const source = [
      "第1段：过密测试",
      "0s-1s｜镜头1｜动作一",
      "1s-2s｜镜头2｜动作二",
      "2s-3s｜镜头3｜动作三",
      "3s-4s｜镜头4｜动作四",
      "4s-5s｜镜头5｜动作五",
      "5s-6s｜镜头6｜动作六",
      "6s-7s｜镜头7｜动作七",
      "7s-8s｜镜头8｜动作八",
    ].join("\n");
    const job = await createSeasonPackCodexJob({ script: source, episodeCount: 1, duration: "15秒" }, { rootDir });
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleEpisodeInput(1, { shotCount: 8 }), null, 2), "utf8");

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /too many planned shots: 8 \/ 5/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("removes source episode labels from render input while preserving segment numbering", async () => {
  const rootDir = makeTempRoot();
  try {
    const source = [
      "第1段｜车棚里的发现",
      "本段为《蔷薇杀手》第三集《车棚里的发现》关键场景。",
      "夜晚，值班人员走向车棚，手电光照到倒下的电动车。",
    ].join("\n");
    const job = await createSeasonPackCodexJob({ script: source, episodeCount: 1, duration: "15秒" }, { rootDir });
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(
      path.join(claimed.episodesDir, "episode-001.json"),
      JSON.stringify(sampleEpisodeInput(1, {
        title: "",
        sourceText: "",
        renderInputScript: "",
      }), null, 2),
      "utf8",
    );

    const completed = await completeSeasonPackCodexJob(job.id, { rootDir });
    const input = completed.result.episodes[0].input;
    assert.equal(input.title, "第1段｜车棚里的发现");
    assert.match(input.renderInputScript, /第 1 段/);
    assert.doesNotMatch(input.renderInputScript, /第三集/);
    assert.doesNotMatch(input.renderInputScript, /第\s*1\s*集/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects compact one-shot season input packs when no explicit source shot list exists", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        script: "第1集：被忘记的角落。清晨街边，草叶、尘土和旁白建立案件世界。",
        episodeCount: 1,
        duration: "15秒",
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleEpisodeInput(1, { shotCount: 1 }), null, 2), "utf8");

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /too few planned shots: 1 \/ 4/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects poisoned render input text", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        script: structuredSourceWithFourShots(),
        episodeCount: 1,
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(
      path.join(claimed.episodesDir, "episode-001.json"),
      JSON.stringify(sampleEpisodeInput(1, { shotCount: 4, renderInputScript: "undefined：错误输入" }), null, 2),
      "utf8",
    );

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /invalid undefined\/null text/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects season pack jobs above 30 episodes", async () => {
  await assert.rejects(
    () => createSeasonPackCodexJob({ script: "A long project outline.", episodeCount: 31 }, { rootDir: makeTempRoot() }),
    /Episode count must be between 1 and 30/,
  );
});

test("does not complete a season pack job when an expected episode file is missing", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        script: "Episode 1 and episode 2 should both be planned.",
        episodeCount: 2,
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleEpisodeInput(1), null, 2), "utf8");

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /episode-002\.json/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
