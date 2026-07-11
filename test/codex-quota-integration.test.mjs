import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const codexCreateRoutes = [
  "app/api/video-prompt/jobs/route.ts",
  "app/api/video-prompt-packs/jobs/route.ts",
  "app/api/season-pack/jobs/route.ts",
  "app/api/prompt-safety/jobs/route.ts",
  "app/api/storyboard-image/jobs/route.ts",
];

const codexClaimRoutes = [
  "app/api/video-prompt/jobs/claim/route.ts",
  "app/api/video-prompt-packs/jobs/claim/route.ts",
  "app/api/season-pack/jobs/claim/route.ts",
  "app/api/prompt-safety/jobs/claim/route.ts",
  "app/api/storyboard-image/jobs/claim/route.ts",
];

const codexPollRoutes = [
  "app/api/video-prompt/jobs/[jobId]/route.ts",
  "app/api/video-prompt-packs/jobs/[jobId]/route.ts",
  "app/api/season-pack/jobs/[jobId]/route.ts",
  "app/api/prompt-safety/jobs/[jobId]/route.ts",
  "app/api/storyboard-image/jobs/[jobId]/route.ts",
];

const codexFailRoutes = [
  "app/api/video-prompt/jobs/[jobId]/fail/route.ts",
  "app/api/video-prompt-packs/jobs/[jobId]/fail/route.ts",
  "app/api/season-pack/jobs/[jobId]/fail/route.ts",
  "app/api/prompt-safety/jobs/[jobId]/fail/route.ts",
  "app/api/storyboard-image/jobs/[jobId]/panels/[panelId]/fail/route.ts",
];

const codexWorkers = [
  "scripts/video-prompt-codex-worker.mjs",
  "scripts/video-prompt-pack-codex-worker.mjs",
  "scripts/season-pack-codex-worker.mjs",
  "scripts/prompt-safety-codex-worker.mjs",
  "scripts/storyboard-codex-worker.mjs",
];

test("Codex job APIs reject or pause work when the global Codex quota circuit is open", () => {
  for (const route of codexCreateRoutes) {
    const source = readFileSync(route, "utf8");
    assert.match(source, /assertCodexRuntimeAvailable/, `${route} should reject creation while Codex is unavailable`);
    assert.match(source, /CODEX_QUOTA_EXHAUSTED/, `${route} should return a quota-specific error`);
  }

  for (const route of codexClaimRoutes) {
    const source = readFileSync(route, "utf8");
    assert.match(source, /getCodexRuntimeState/, `${route} should check global Codex runtime state before claiming`);
    assert.match(source, /codexUnavailable/, `${route} should tell workers that Codex is unavailable without claiming work`);
  }

  for (const route of codexPollRoutes) {
    const source = readFileSync(route, "utf8");
    assert.match(source, /getCodexRuntimeState/, `${route} should check global Codex runtime state while polling`);
    assert.match(source, /codexUnavailable/, `${route} should tell the UI that Codex is unavailable`);
    assert.match(source, /fail.*Codex.*Job/, `${route} should fail stale pending work instead of letting the UI time out`);
  }

  for (const route of codexFailRoutes) {
    const source = readFileSync(route, "utf8");
    assert.match(source, /markCodexQuotaExhausted/, `${route} should trip the quota circuit when a worker reports quota exhaustion`);
    assert.match(source, /isCodexQuotaExhaustedMessage/, `${route} should recognize quota failure messages`);
  }
});

test("Codex workers capture CLI output and normalize quota failures", async () => {
  assert.equal(existsSync("scripts/codex-runtime-utils.mjs"), true, "worker quota utility should exist");
  const helper = await import(`../scripts/codex-runtime-utils.mjs?cache=${Date.now()}`);
  const message = helper.buildCodexFailureMessage("codex exec exited with code 1", "Usage limit reached");
  assert.match(message, /CODEX_QUOTA_EXHAUSTED/);
  assert.match(message, /Codex 额度/);

  const contractEchoMessage = helper.buildCodexFailureMessage(
    "codex exec exited with code 1",
    'SEGMENT CONTRACT: { "sourceText": "secret", "forbiddenFutureEvents": ["future"], "requiredShotBeats": [] }',
  );
  assert.match(contractEchoMessage, /Codex returned task prompt or SegmentContract text/);
  assert.doesNotMatch(contractEchoMessage, /forbiddenFutureEvents/);

  const versionMessage = helper.buildCodexFailureMessage(
    "codex exec exited with code 1",
    `${"SEGMENT CONTRACT task prompt ".repeat(80)}The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.`,
  );
  assert.match(versionMessage, /CODEX_CLI_VERSION_UNSUPPORTED/);
  assert.match(versionMessage, /Codex CLI 版本过旧/);
  assert.doesNotMatch(versionMessage, /task prompt or SegmentContract/);

  for (const worker of codexWorkers) {
    const source = readFileSync(worker, "utf8");
    assert.match(source, /codex-runtime-utils\.mjs/, `${worker} should import quota normalization helpers`);
    assert.match(source, /buildCodexFailureMessage/, `${worker} should normalize Codex CLI failures`);
    assert.match(source, /capturedOutput/, `${worker} should capture stdout\/stderr for quota detection`);
    assert.match(source, /stdio:\s*\["pipe",\s*"pipe",\s*"pipe"\]/, `${worker} should pipe child output so quota messages are observable`);
  }
});

test("Codex quota failures are mapped to user-facing UI messages", () => {
  const dashboardSource = readFileSync("components/DashboardClient.tsx", "utf8");
  assert.match(dashboardSource, /formatUserFacingError/, "dashboard should format raw Codex quota errors");
  assert.match(dashboardSource, /Codex 额度已用完或暂时受限/, "dashboard should show a clear quota message");
  assert.match(dashboardSource, /setPromptSafetyError\(formatUserFacingError/, "dashboard prompt safety errors should be friendly");
  assert.match(dashboardSource, /setImageError\(formatUserFacingError/, "dashboard storyboard errors should be friendly");

  const projectsSource = readFileSync("components/ProjectsClient.tsx", "utf8");
  assert.match(projectsSource, /getFriendlyProjectError/, "projects page should format raw Codex quota errors");
  assert.match(projectsSource, /Codex 额度已用完或暂时受限/, "projects page should show a clear quota message");
  assert.match(projectsSource, /setStoryboardGenerationError/, "projects storyboard errors should be routed through friendly display");
  assert.match(projectsSource, /setPromptSafetyError\(getFriendlyProjectError/, "projects prompt safety errors should be friendly");
});
