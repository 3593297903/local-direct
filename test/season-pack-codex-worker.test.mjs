import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("season pack Codex worker invokes one codex exec and reports job status", () => {
  const source = readFileSync("scripts/season-pack-codex-worker.mjs", "utf8");
  const packageJson = readFileSync("package.json", "utf8");

  assert.match(packageJson, /"season-pack:codex-worker": "node scripts\/season-pack-codex-worker\.mjs"/);
  assert.match(source, /Local Director season pack Codex worker started/);
  assert.match(source, /\/api\/season-pack\/jobs\/claim/);
  assert.match(source, /\/api\/season-pack\/jobs\/\$\{encodeURIComponent\(task\.id\)\}\/complete/);
  assert.match(source, /\/api\/season-pack\/jobs\/\$\{encodeURIComponent\(task\.id\)\}\/fail/);
  assert.match(source, /codex/);
  assert.match(source, /exec/);
  assert.match(source, /--output-last-message/);
  assert.match(source, /SEASON_PACK_CODEX_MODEL/);
  assert.match(source, /SEASON_PACK_CODEX_PROFILE/);
  assert.match(source, /SEASON_PACK_CODEX_WORKER_TOKEN/);
  assert.match(source, /task\.prompt/);
  assert.match(source, /assertSeasonPackOutput/);
  assert.match(source, /manifestPath/);
  assert.match(source, /episodesDir/);
  assert.match(source, /finalizeSeasonPackCodexJobFiles/);
  assert.match(source, /updateSeasonPackCodexJobStage/);
  assert.match(source, /child\.on\("close"/);
  assert.doesNotMatch(source, /child\.on\("exit"/);
  assert.match(source, /resultRef/);
  assert.match(source, /errorCode/);
  assert.match(source, /class WorkerRequestError extends Error/);
  assert.match(source, /let outputReady = false/);
  assert.match(source, /if \(outputReady\)/);
  assert.match(source, /JOB_STORAGE_BUSY/);
});
