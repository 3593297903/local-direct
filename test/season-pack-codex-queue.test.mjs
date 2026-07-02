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

function sampleAnalysisResult(index) {
  return {
    title: `Episode ${index}`,
    contentType: "short drama",
    duration: "15 seconds",
    style: "cinematic realism",
    diagnosis: ["episode prompt"],
    optimizedScript: `Episode ${index} optimized script.`,
    workflow: {
      sourceAnalysis: `Episode ${index} source.`,
      coreTheme: `Episode ${index} theme.`,
      videoParameterLock: "duration 15 seconds, 16:9",
      screenplay: `Episode ${index} screenplay.`,
      filmScript: `Episode ${index} film script.`,
      fullVideoPrompt: `Episode ${index} full video prompt.`,
      fullNegativePrompt: "no gore, no text errors",
      concisePrompt: `Episode ${index} concise prompt.`,
    },
    storyboard: [
      {
        shotNumber: 1,
        timeRange: "0.0s-3.0s",
        scene: `Episode ${index} scene`,
        visual: `Episode ${index} visual beat`,
        shotType: "medium shot",
        composition: "eye-level medium shot with a clear foreground and background",
        cameraMovement: "slow push in",
        lighting: "soft natural light with controlled contrast",
        sound: "quiet ambience",
        dialogue: "none",
        emotion: "restrained",
        transition: "cut",
        shotPurpose: "establish the episode conflict",
        firstFramePrompt: `Episode ${index} first frame`,
        videoPrompt: `Episode ${index} video prompt`,
        lastFramePrompt: `Episode ${index} last frame`,
        negativePrompt: "no gore, no distorted faces, no text errors",
      },
    ],
  };
}

test("creates, claims, and completes a season pack Codex job from per-episode files", async () => {
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
    assert.match(job.prompt, /write exactly 2 episode JSON files/i);
    assert.match(job.prompt, /episode-001\.json/);
    assert.match(job.packDir, /\.tmp-season-pack-codex[\\/]packs[\\/]season-pack-job-/);
    assert.equal(job.result, null);

    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, "running");

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(claimed.manifestPath, JSON.stringify({ episodeCount: 2, generatedEpisodes: [1, 2] }, null, 2), "utf8");
    writeFileSync(claimed.seasonPlanPath, JSON.stringify({ episodes: [{ index: 1 }, { index: 2 }] }, null, 2), "utf8");
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleAnalysisResult(1), null, 2), "utf8");
    writeFileSync(path.join(claimed.episodesDir, "episode-002.json"), JSON.stringify(sampleAnalysisResult(2), null, 2), "utf8");

    const completed = await completeSeasonPackCodexJob(claimed.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.episodes.length, 2);
    assert.equal(completed.result.episodes[0].episodeIndex, 1);
    assert.equal(completed.result.episodes[1].result.workflow.fullVideoPrompt, "Episode 2 full video prompt.");

    const reloaded = await getSeasonPackCodexJob(job.id, { rootDir });
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.result.episodes[0].result.optimizedScript, "Episode 1 optimized script.");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("normalizes empty storyboard dialogue instead of failing a completed season pack", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createSeasonPackCodexJob(
      {
        script: "Episode 1 has a silent shot without dialogue.",
        episodeCount: 1,
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const result = sampleAnalysisResult(1);
    result.storyboard[0].dialogue = "";

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(result, null, 2), "utf8");

    const completed = await completeSeasonPackCodexJob(job.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.episodes[0].result.storyboard[0].dialogue, "无");
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
        script: "Episode 1 and episode 2 should both be generated.",
        episodeCount: 2,
      },
      { rootDir },
    );
    const claimed = await claimNextSeasonPackCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(claimed.episodesDir, { recursive: true });
    writeFileSync(path.join(claimed.episodesDir, "episode-001.json"), JSON.stringify(sampleAnalysisResult(1), null, 2), "utf8");

    await assert.rejects(
      () => completeSeasonPackCodexJob(job.id, { rootDir }),
      /episode-002\.json/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
