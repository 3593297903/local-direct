import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
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
  CODEX_QUOTA_EXHAUSTED_CODE,
  CODEX_QUOTA_EXHAUSTED_MESSAGE,
  assertCodexRuntimeAvailable,
  clearCodexRuntimeState,
  getCodexRuntimeState,
  isCodexQuotaExhaustedMessage,
  markCodexQuotaExhausted,
  normalizeCodexQuotaErrorMessage,
} = require("../lib/codex-runtime-state.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-codex-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("detects Codex quota and usage-limit errors from CLI output", () => {
  assert.equal(CODEX_QUOTA_EXHAUSTED_CODE, "CODEX_QUOTA_EXHAUSTED");
  assert.match(CODEX_QUOTA_EXHAUSTED_MESSAGE, /Codex/);
  assert.equal(isCodexQuotaExhaustedMessage("insufficient_quota: credits exhausted"), true);
  assert.equal(isCodexQuotaExhaustedMessage("Usage limit reached for this account"), true);
  assert.equal(isCodexQuotaExhaustedMessage("429 rate limit exceeded"), true);
  assert.equal(isCodexQuotaExhaustedMessage("JSON parse failed"), false);

  const normalized = normalizeCodexQuotaErrorMessage("codex exec exited with code 1\nUsage limit reached");
  assert.match(normalized, /CODEX_QUOTA_EXHAUSTED/);
  assert.match(normalized, /Codex 额度/);
});

test("global Codex runtime state blocks new work until the circuit expires or is cleared", async () => {
  const rootDir = makeTempRoot();
  mkdirSync(rootDir, { recursive: true });
  try {
    const emptyState = await getCodexRuntimeState({ rootDir });
    assert.equal(emptyState.available, true);

    await markCodexQuotaExhausted("video-prompt", "Usage limit reached", { rootDir, ttlMs: 60_000 });
    const blockedState = await getCodexRuntimeState({ rootDir });
    assert.equal(blockedState.available, false);
    assert.equal(blockedState.code, CODEX_QUOTA_EXHAUSTED_CODE);
    assert.match(blockedState.message, /Codex 额度/);

    await assert.rejects(
      () => assertCodexRuntimeAvailable({ rootDir }),
      /CODEX_QUOTA_EXHAUSTED/,
    );

    await clearCodexRuntimeState({ rootDir });
    const clearedState = await getCodexRuntimeState({ rootDir });
    assert.equal(clearedState.available, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
