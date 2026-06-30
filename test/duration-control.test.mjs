import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("dashboard sends selected video duration to analysis API", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /const \[durationSeconds, setDurationSeconds\] = useState\(15\)/);
  assert.match(dashboardSource, /aria-label="视频时长"/);
  assert.match(dashboardSource, /min="4"/);
  assert.match(dashboardSource, /max="15"/);
  assert.match(dashboardSource, /setDurationSeconds\(Number\(e\.target\.value\)\)/);
  assert.match(dashboardSource, /async function requestAnalysis\(inputScript: string, inputDurationSeconds: number\)/);
  assert.match(dashboardSource, /duration: `\$\{inputDurationSeconds\}秒`/);
  assert.match(dashboardSource, /requestAnalysis\(script, durationSeconds\)/);
});

test("analysis prompt treats duration as a budget and infers shot count from script rhythm", async () => {
  const aiSource = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");
  const routeSource = await readFile(join(process.cwd(), "app", "api", "analyze", "route.ts"), "utf8");

  assert.match(routeSource, /duration: z\.string\(\)\.default\("15秒"\)/);
  assert.match(aiSource, /buildShotCountGuidance/);
  assert.match(aiSource, /先分析文案节拍/);
  assert.match(aiSource, /不要按固定区间机械决定镜头数/);
  assert.match(aiSource, /4-15 秒/);
  assert.match(aiSource, /实际总时长允许在/);
  assert.match(aiSource, /上限前 1 秒/);
  assert.match(aiSource, /不要强制等于所选总时长/);
  assert.doesNotMatch(aiSource, /时间轴总和必须等于所选总时长/);
});
