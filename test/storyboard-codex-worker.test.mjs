import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("storyboard Codex worker invokes codex exec and reports panel status", () => {
  const workerPath = "scripts/storyboard-codex-worker.mjs";
  assert.equal(existsSync(workerPath), true, `${workerPath} should exist`);

  const source = readFileSync(workerPath, "utf8");
  assert.match(source, /codex exec/);
  assert.match(source, /\$imagegen/);
  assert.match(source, /\/api\/storyboard-image\/jobs\/claim/);
  assert.match(source, /\/complete/);
  assert.match(source, /\/fail/);
  assert.match(source, /assertOutputFile/);
  assert.match(source, /STORYBOARD_CODEX_API_BASE_URL/);
});

test("storyboard Codex worker runs a bounded local concurrency pool", () => {
  const source = readFileSync("scripts/storyboard-codex-worker.mjs", "utf8");

  assert.match(source, /STORYBOARD_CODEX_CONCURRENCY/);
  assert.match(source, /positiveInteger\(process\.env\.STORYBOARD_CODEX_CONCURRENCY,\s*5\)/);
  assert.match(source, /STORYBOARD_CODEX_TASK_TIMEOUT_MS/);
  assert.match(source, /child\.kill/);
  assert.match(source, /activeTasks/);
  assert.match(source, /processTask/);
  assert.match(source, /codex-messages/);
  assert.doesNotMatch(source, /last-codex-message\.txt/);
});

test("package exposes storyboard Codex worker command", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["storyboard:codex-worker"], "node scripts/storyboard-codex-worker.mjs");
});
