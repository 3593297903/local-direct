import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("combined worker launcher includes event judge and repairs-only workers", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts", "codex-workers.mjs"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.scripts["codex:workers"], "node scripts/codex-workers.mjs");
  assert.match(source, /event-coverage-codex-worker\.mjs/);
  assert.match(source, /batch-segment-repair-codex-worker\.mjs/);
  assert.match(source, /video-prompt-pack-codex-worker\.mjs/);
  assert.match(source, /season-pack-codex-worker\.mjs/);
  assert.match(source, /windowsHide: true/);
});
