import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Render consumers settle independently and are capped at four", async () => {
  const dashboard = await readFile(path.join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");
  const scheduler = await readFile(path.join(process.cwd(), "lib", "batch-render-scheduler.ts"), "utf8");

  assert.doesNotMatch(scheduler, /concurrency:\s*8/);
  assert.match(scheduler, /concurrency:\s*4/);
  assert.match(dashboard, /Promise\.allSettled\(Array\.from\(\{ length: renderPackConcurrency \}/);
  assert.doesNotMatch(dashboard, /await Promise\.all\(Array\.from\(\{ length: renderPackConcurrency \}/);
});

test("Season and Render workers heartbeat file jobs while waiting, executing, and finalizing", async () => {
  const season = await readFile(path.join(process.cwd(), "scripts", "season-pack-codex-worker.mjs"), "utf8");
  const render = await readFile(path.join(process.cwd(), "scripts", "video-prompt-pack-codex-worker.mjs"), "utf8");

  assert.match(season, /heartbeatSeasonPackCodexJob/);
  assert.match(render, /heartbeatVideoPromptPackCodexJob/);
  assert.match(season, /startFileJobHeartbeat/);
  assert.match(render, /startFileJobHeartbeat/);
  assert.match(season, /markSeasonPackCodexJobExited/);
  assert.match(render, /markVideoPromptPackCodexJobExited/);
});

test("Codex exit timestamps are recorded before finalization and exposed in lightweight DTOs", async () => {
  const seasonQueue = await readFile(path.join(process.cwd(), "lib", "season-pack-codex-queue.ts"), "utf8");
  const renderQueue = await readFile(path.join(process.cwd(), "lib", "video-prompt-pack-codex-queue.ts"), "utf8");

  for (const source of [seasonQueue, renderQueue]) {
    assert.match(source, /codexExitedAt\?: string/);
    assert.match(source, /export async function mark.*CodexJobExited/);
    assert.match(source, /export async function heartbeat.*CodexJob/);
    assert.match(source, /job\.codexExitedAt \? \{ codexExitedAt: job\.codexExitedAt \} : \{\}/);
  }
  assert.match(renderQueue, /codexExitedAt: job\.codexExitedAt \|\| new Date\(\)\.toISOString\(\)/);
});

test("model execution timeout is created only inside runCodex after slot acquisition", async () => {
  for (const fileName of ["season-pack-codex-worker.mjs", "video-prompt-pack-codex-worker.mjs"]) {
    const source = await readFile(path.join(process.cwd(), "scripts", fileName), "utf8");
    const slotIndex = source.indexOf("withCodexCliSlot(");
    const runIndex = source.indexOf("async function runCodex");
    const timeoutIndex = source.indexOf("setTimeout(() =>", runIndex);
    assert.equal(slotIndex >= 0, true, fileName);
    assert.equal(runIndex > slotIndex, true, fileName);
    assert.equal(timeoutIndex > runIndex, true, fileName);
  }
});
