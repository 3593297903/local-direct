import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const aiModulePath = join(compiledDir, "duration-ai.mjs");
const aiModuleUrl = pathToFileURL(aiModulePath).href;

await mkdir(compiledDir, { recursive: true });
let aiSourceForRuntime = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");
aiSourceForRuntime = aiSourceForRuntime
  .replace('import { buildMockAnalysis } from "@/lib/mock";', "const buildMockAnalysis = () => ({});")
  .replace(
    'import { AI_VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT } from "@/lib/prompt-optimizer-skill";',
    'const AI_VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT = "system";',
  )
  .replace(
    'import { durationSince, logger } from "@/lib/logger";',
    'const durationSince = () => 0; const logger = { info() {}, warn() {}, error() {}, debug() {} };',
  );
const compiledAi = ts.transpileModule(aiSourceForRuntime, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;
await writeFile(aiModulePath, compiledAi, "utf8");

test("dashboard defaults to automatic duration and only sends fixed seconds after manual selection", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /type DurationMode = "auto" \| "fixed"/);
  assert.match(dashboardSource, /const \[durationMode, setDurationMode\] = useState<DurationMode>\("auto"\)/);
  assert.match(dashboardSource, /const \[durationSeconds, setDurationSeconds\] = useState\(15\)/);
  assert.match(dashboardSource, /aria-label="视频时长"/);
  assert.match(dashboardSource, /min="4"/);
  assert.match(dashboardSource, /max="15"/);
  assert.match(dashboardSource, /selectedDurationValue\(\)/);
  assert.match(dashboardSource, /durationMode === "auto" \? "auto" : `\$\{durationSeconds\}秒`/);
  assert.match(dashboardSource, /setDurationSeconds\(Number\(e\.target\.value\)\)/);
  assert.match(dashboardSource, /async function requestAnalysis\(inputScript: string, inputDuration: string\)/);
  assert.match(dashboardSource, /duration: inputDuration/);
  assert.match(dashboardSource, /requestAnalysis\(script, selectedDurationValue\(\)\)/);
});

test("analysis prompt treats duration as an automatic budget unless the user fixes seconds", async () => {
  const aiSource = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");
  const routeSource = await readFile(join(process.cwd(), "app", "api", "analyze", "route.ts"), "utf8");

  assert.match(routeSource, /duration: z\.string\(\)\.optional\(\)\.default\("auto"\)/);
  assert.match(aiSource, /extractExplicitDurationSeconds/);
  assert.match(aiSource, /buildShotCountGuidance/);
  assert.match(aiSource, /normalizeDuration/);
  assert.match(aiSource, /4-15/);
});

test("automatic duration honors explicit seconds in the source script before estimating", async () => {
  const { normalizeDuration } = await import(aiModuleUrl);

  assert.equal(normalizeDuration("auto", "总时长：6秒。一个人推开门。"), "6秒");
  assert.equal(normalizeDuration(undefined, "请生成一条 11 秒的短片，主角穿过走廊。"), "11秒");
  assert.equal(normalizeDuration("7秒", "总时长：12秒。一个人推开门。"), "7秒");
});
