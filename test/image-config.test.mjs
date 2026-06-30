import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readEnvFile(path) {
  return readFileSync(path, "utf8");
}

function activeValue(envText, key) {
  const line = envText
    .split(/\r?\n/)
    .find((item) => item.startsWith(`${key}=`));
  return line?.slice(key.length + 1) || "";
}

test("image config uses a supported real image provider model", () => {
  const envLocal = readEnvFile(".env.local");
  const envExample = readEnvFile(".env.example");
  const provider = activeValue(envLocal, "IMAGE_PROVIDER");
  const model = activeValue(envLocal, "IMAGE_MODEL");

  const supportedModelsByProvider = {
    openai: ["gpt-image-1", "gpt-image-2"],
    gemini: ["gemini-2.5-flash-image", "gemini-3.1-flash-image"],
    openrouter: ["google/gemini-2.5-flash-image"],
    qwen: ["qwen-image"],
    mock: ["mock"],
  };

  assert.ok(provider in supportedModelsByProvider, `${provider} should be a supported image provider`);
  assert.ok(
    supportedModelsByProvider[provider].includes(model),
    `${model} should be supported for ${provider}`,
  );

  assert.match(envExample, /IMAGE_PROVIDER=mock/);
  assert.match(envExample, /IMAGE_MODEL=gpt-image-1/);
});

test("storyboard image prompt and cropper preserve one panel per shot", () => {
  const routeSource = readFileSync("app/api/storyboard-image/route.ts", "utf8");
  const dashboardSource = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(routeSource, /buildSinglePanelPrompt/);
  assert.match(routeSource, /Create ONE single storyboard panel/);
  assert.match(routeSource, /makeSheetFromPanelImages/);
  assert.match(routeSource, /panelImages/);
  assert.match(routeSource, /panels: panelImages/);
  assert.match(routeSource, /Non-negotiable panel count/);
  assert.match(routeSource, /exactly \$\{panelCount\} separate panels/);
  assert.match(routeSource, /Do NOT merge two shots into one panel/);
  assert.match(routeSource, /equal-height horizontal rows/);
  assert.match(routeSource, /thick, straight, full-width black horizontal divider/);

  assert.match(dashboardSource, /normalizeStoryboardPanels/);
  assert.match(dashboardSource, /data\.panels/);
  assert.match(dashboardSource, /detectStoryboardPanelBoxes/);
  assert.match(dashboardSource, /rowScores/);
  assert.match(dashboardSource, /internalBands/);
  assert.match(dashboardSource, /equalBoxes/);
});
