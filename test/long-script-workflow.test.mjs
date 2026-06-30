import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
await mkdir(compiledDir, { recursive: true });

async function compileModule(sourcePath, outputName) {
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  const outputPath = join(compiledDir, outputName);
  await writeFile(outputPath, compiled, "utf8");
  return pathToFileURL(outputPath).href;
}

test("long uploaded copy is split into ordered 15-second prompt segments", async () => {
  const moduleUrl = await compileModule(join(process.cwd(), "lib", "long-script.ts"), "long-script.mjs");
  const { splitLongScriptIntoPromptSegments } = await import(moduleUrl);
  const paragraph = "林夏收到旧照片，照片背面写着一栋废弃大楼的地址。她撑伞走进雨夜，楼道尽头传来旧收音机的声音。她看见照片里多年后死去的自己站在窗边，对她做出安静的手势。";
  const script = Array.from({ length: 18 }, () => paragraph).join("\n\n");

  const segments = splitLongScriptIntoPromptSegments(script, { maxChars: 260, minChars: 90 });

  assert.ok(segments.length > 3);
  assert.equal(segments[0].index, 1);
  assert.equal(segments.at(-1).index, segments.length);
  assert.ok(segments.every((segment) => segment.text.length <= 320));
  assert.match(segments.map((segment) => segment.text).join(""), /旧照片/);
});

test("prompt docx generator returns a downloadable Word document", async () => {
  const moduleUrl = await compileModule(join(process.cwd(), "lib", "prompt-docx.ts"), "prompt-docx.mjs");
  const { createPromptDocxBuffer } = await import(moduleUrl);

  const buffer = createPromptDocxBuffer({
    title: "AI 视频提示词",
    sections: [
      {
        heading: "第 1 段",
        originalText: "一个人在雨夜收到旧照片。",
        promptText: "核心主题：雨夜旧照片。\n镜头画面 + 时间轴 + 声音 / 台词：0.0s-3.0s。",
      },
    ],
  });

  assert.equal(buffer.subarray(0, 2).toString("utf8"), "PK");
  const asText = buffer.toString("utf8");
  assert.match(asText, /word\/document\.xml/);
  assert.match(asText, /AI 视频提示词/);
  assert.match(asText, /核心主题/);
});

test("dashboard exposes upload, batch generation progress, and docx download", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /accept="\.txt,\.docx"/);
  assert.match(dashboardSource, /handlePromptFileUpload/);
  assert.match(dashboardSource, /batchGenerating/);
  assert.match(dashboardSource, /正在生成/);
  assert.match(dashboardSource, /downloadPromptDocx/);
  assert.match(dashboardSource, /下载 DOCX/);
});
