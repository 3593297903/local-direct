import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { shouldPublishProjectVersionMemory } = require(
  "../apps/api/src/modules/projects/project-memory-publish-policy.ts",
);

test("needs-review versions are archived without publishing unconfirmed narrative memory", () => {
  assert.equal(shouldPublishProjectVersionMemory("needs_review"), false);
});

test("normal draft and completed versions continue publishing narrative memory", () => {
  assert.equal(shouldPublishProjectVersionMemory("draft"), true);
  assert.equal(shouldPublishProjectVersionMemory("completed"), true);
  assert.equal(shouldPublishProjectVersionMemory(undefined), true);
});
