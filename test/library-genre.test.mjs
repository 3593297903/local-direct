import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const compiledDir = join(root, ".next-test");
const genreOptionsPath = join(compiledDir, "genre-options.mjs");
const libraryStorePath = join(compiledDir, "library-store-genre.mjs");
const knowledgeGenrePath = join(compiledDir, "knowledge-genre.mjs");

async function compileModule(sourcePath, outputPath, replacements = []) {
  let source = await readFile(sourcePath, "utf8");
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
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

test("genre options include the approved single-choice material genres", async () => {
  await compileModule(join(root, "lib", "genre-options.ts"), genreOptionsPath);
  const moduleUrl = pathToFileURL(genreOptionsPath).href;
  const { GENRE_OPTIONS } = await import(moduleUrl);

  assert.deepEqual(GENRE_OPTIONS, [
    "剧情",
    "动作",
    "冒险",
    "战斗",
    "喜剧",
    "爱情",
    "悬疑",
    "惊悚",
    "恐怖",
    "犯罪",
    "警匪",
    "科幻",
    "奇幻",
    "古风",
    "日常",
    "灾难",
    "战争",
    "历史",
  ]);
});

test("library search can match a material by genre", async () => {
  await compileModule(join(root, "lib", "knowledge.ts"), knowledgeGenrePath);
  await compileModule(join(root, "lib", "library-store.ts"), libraryStorePath, [["./knowledge", "./knowledge-genre.mjs"]]);
  const moduleUrl = pathToFileURL(libraryStorePath).href;
  const { filterKnowledgeItems } = await import(moduleUrl);
  const items = [
    {
      id: "warm-closeup",
      type: "shot",
      category: "特写",
      genre: "爱情",
      name: "温暖特写",
      description: "",
      prompt: "",
      tags: [],
      stability: 90,
      useCase: "",
    },
    {
      id: "cold-closeup",
      type: "shot",
      category: "特写",
      genre: "恐怖",
      name: "阴冷特写",
      description: "",
      prompt: "",
      tags: [],
      stability: 90,
      useCase: "",
    },
  ];

  const result = filterKnowledgeItems(items, "爱情", "shot");

  assert.deepEqual(result.map((item) => item.id), ["warm-closeup"]);
});
