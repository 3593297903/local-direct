import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("video prompt Codex worker invokes codex exec and reports job status", () => {
  const source = readFileSync("scripts/video-prompt-codex-worker.mjs", "utf8");
  const packageJson = readFileSync("package.json", "utf8");

  assert.match(packageJson, /"video-prompt:codex-worker": "node scripts\/video-prompt-codex-worker\.mjs"/);
  assert.match(source, /Local Director video prompt Codex worker started/);
  assert.match(source, /\/api\/video-prompt\/jobs\/claim/);
  assert.match(source, /\/api\/video-prompt\/jobs\/\$\{encodeURIComponent\(task\.id\)\}\/complete/);
  assert.match(source, /\/api\/video-prompt\/jobs\/\$\{encodeURIComponent\(task\.id\)\}\/fail/);
  assert.match(source, /codex/);
  assert.match(source, /exec/);
  assert.match(source, /--output-last-message/);
  assert.match(source, /strict JSON/);
  assert.match(source, /AnalysisResult/);
  assert.match(source, /UTF-8/);
  assert.match(source, /fs\.writeFileSync/);
  assert.match(source, /Set-Content/);
  assert.match(source, /assertOutputJson/);
  assert.match(source, /assertNoEncodingDamage/);
  assert.match(source, /stripJsonBom/);
  assert.match(source, /VIDEO_PROMPT_CODEX_WORKER_TOKEN/);
  assert.match(source, /VIDEO_PROMPT_CODEX_CONCURRENCY/);
  assert.match(source, /activeTasks/);
  assert.match(source, /Promise\.race\(activeTasks\)/);
});
