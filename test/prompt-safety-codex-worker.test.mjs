import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("prompt safety Codex worker invokes codex exec and reports job status", () => {
  const source = readFileSync("scripts/prompt-safety-codex-worker.mjs", "utf8");
  const packageJson = readFileSync("package.json", "utf8");

  assert.match(packageJson, /"prompt-safety:codex-worker": "node scripts\/prompt-safety-codex-worker\.mjs"/);
  assert.match(source, /Local Director prompt safety Codex worker started/);
  assert.match(source, /\/api\/prompt-safety\/jobs\/claim/);
  assert.match(source, /\/api\/prompt-safety\/jobs\/\$\{encodeURIComponent\(task\.id\)\}\/complete/);
  assert.match(source, /\/api\/prompt-safety\/jobs\/\$\{encodeURIComponent\(task\.id\)\}\/fail/);
  assert.match(source, /codex/);
  assert.match(source, /exec/);
  assert.match(source, /--output-last-message/);
  assert.match(source, /Seedance 2\.0/);
  assert.match(source, /patches/);
  assert.match(source, /strict word-level replacement patches only/);
  assert.match(source, /closest compliant word or short phrase/);
  assert.match(source, /optimizedResult/);
  assert.match(source, /assertOutputJson/);
  assert.match(source, /stripJsonBom/);
  assert.match(source, /PROMPT_SAFETY_CODEX_WORKER_TOKEN/);
});
