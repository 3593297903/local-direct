import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("home page uses a centered workspace-style layout without the old feature sections", () => {
  const page = readFileSync("app/page.tsx", "utf8");

  assert.doesNotMatch(page, /features\s*=/);
  assert.doesNotMatch(page, /Next stage/i);
  assert.doesNotMatch(page, /脚本拆解|转场知识库|镜头语言库/);
  assert.match(page, /workspace-hero-shell/);
  assert.match(page, /workspace-orb-field/);
  assert.match(page, /title-planet/);
  assert.doesNotMatch(page, /DIRECTOR FEED/);
  assert.doesNotMatch(page, /AI READY/);
  assert.doesNotMatch(page, /workflow\.map/);
  assert.match(page, /max-w-5xl/);
});

test("Nest projects proxy avoids optional property question marks in local type blocks", () => {
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.doesNotMatch(proxy, /\w+\?:/);
  assert.match(proxy, /type ProjectCreatePayload = Record<string, unknown>/);
  assert.match(proxy, /type NestResponse = Record<string, unknown>/);
});
