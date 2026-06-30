import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const modulePath = join(compiledDir, "reference-matcher.mjs");
const moduleUrl = pathToFileURL(modulePath).href;

async function compileModule(sourcePath, outputPath) {
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  await writeFile(outputPath, compiled, "utf8");
}

await mkdir(compiledDir, { recursive: true });
await compileModule(join(process.cwd(), "lib", "reference-matcher.ts"), modulePath);

const items = [
  { id: "shot-medium-a", type: "shot", name: "中景", tags: ["#对话"] },
  { id: "shot-medium-b", type: "shot", name: "中景 - 雨夜人物", tags: ["#雨夜"] },
  { id: "shot-close", type: "shot", name: "特写", tags: [] },
  { id: "camera-push", type: "camera_movement", name: "缓慢推进", tags: [] },
  { id: "camera-static", type: "camera_movement", name: "固定镜头", tags: [] },
  { id: "transition-action", type: "transition", name: "动作衔接", tags: [] },
  { id: "transition-match", type: "transition", name: "匹配剪辑", tags: [] },
  { id: "transition-hard", type: "transition", name: "硬切", tags: [] },
];

test("matches all references for shot, camera movement, and transition text", async () => {
  const { matchShotReferences } = await import(moduleUrl);
  const shot = {
    shotType: "中景推进到特写",
    cameraMovement: "缓慢推进，焦点从照片到人脸",
    transition: "动作匹配（翻照片）",
  };

  const refs = matchShotReferences(shot, items);

  assert.deepEqual(refs.shot.map((item) => item.id), ["shot-medium-a", "shot-medium-b", "shot-close"]);
  assert.deepEqual(refs.camera.map((item) => item.id), ["camera-push"]);
  assert.deepEqual(refs.transition.map((item) => item.id), ["transition-action", "transition-match"]);
});

test("falls back to hard cut when the transition text says direct cut", async () => {
  const { matchShotReferences } = await import(moduleUrl);
  const refs = matchShotReferences({ shotType: "", cameraMovement: "固定", transition: "直接切到下一镜头" }, items);

  assert.deepEqual(refs.camera.map((item) => item.id), ["camera-static"]);
  assert.deepEqual(refs.transition.map((item) => item.id), ["transition-hard"]);
});
