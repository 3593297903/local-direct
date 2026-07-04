import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Projects page downloads prompt DOCX for a selected segment range", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /promptDownloadPanelOpen/);
  assert.match(client, /promptDownloadRangeStart/);
  assert.match(client, /promptDownloadRangeEnd/);
  assert.match(client, /downloadPromptDocx/);
  assert.match(client, /downloadPromptDocx\("complete"\)/);
  assert.match(client, /downloadPromptDocx\("review"\)/);
  assert.match(client, /下载完整提示词/);
  assert.match(client, /下载审阅版/);
  assert.match(client, /getPromptDownloadVersions/);
  assert.match(client, /setPromptDownloadRange/);
  assert.match(client, /promptDownloadVersions\.map/);
  assert.match(client, /\/api\/prompt-docx/);
  assert.match(client, /selectedVersion\.versionNumber/);
  assert.match(client, /project\.versions\.length/);
});
