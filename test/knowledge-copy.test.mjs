import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const modulePath = join(compiledDir, "knowledge-copy.mjs");
const moduleUrl = pathToFileURL(modulePath).href;

await mkdir(compiledDir, { recursive: true });
const source = await readFile(join(process.cwd(), "lib", "knowledge-copy.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;
await writeFile(modulePath, compiled, "utf8");

test("copy drafts get a unique id, next copy name, and no fixed order", async () => {
  const { createKnowledgeItemCopyDraft } = await import(moduleUrl);
  const sourceItem = {
    id: "transition-fade",
    type: "transition",
    category: "transition",
    name: "淡入淡出",
    description: "description",
    prompt: "prompt",
    tags: ["soft"],
    stability: 90,
    order: 2,
    useCase: "use",
    previewUrl: "/previews/fade.mp4",
    posterUrl: "/previews/posters/fade.jpg",
  };

  const draft = createKnowledgeItemCopyDraft(sourceItem, [
    sourceItem,
    { ...sourceItem, id: "transition-fade-copy", name: "淡入淡出 副本" },
  ], 1780000000000);

  assert.equal(draft.id, "copy-transition-fade-1780000000000");
  assert.equal(draft.name, "淡入淡出 副本 2");
  assert.equal(draft.order, undefined);
  assert.equal(draft.previewUrl, sourceItem.previewUrl);
  assert.equal(draft.posterUrl, sourceItem.posterUrl);
});
