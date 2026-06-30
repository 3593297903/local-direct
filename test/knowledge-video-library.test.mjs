import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

test("knowledge libraries are populated with local video previews", () => {
  const items = JSON.parse(readFileSync("data/knowledge-items.json", "utf8"));
  const counts = items.reduce((next, item) => {
    next[item.type] = (next[item.type] || 0) + 1;
    return next;
  }, {});

  assert.ok(items.length >= 30);
  assert.ok(counts.shot >= 1);
  assert.ok(counts.camera_movement >= 1);
  assert.ok(counts.transition >= 1);

  for (const item of items) {
    assert.match(item.previewUrl, /^\/previews\/.+\.mp4$/);
    assert.equal(item.previewMimeType, "video/mp4");
    assert.equal(existsSync(`public${item.previewUrl}`), true, `${item.previewUrl} should exist`);
  }
});

test("library cards render single-hash tags and no corner arrow affordance", () => {
  const source = readFileSync("components/LibraryCard.tsx", "utf8");

  assert.equal(source.includes("ArrowUpRight"), false);
});

test("library drawer does not expose stability score badges", () => {
  const source = readFileSync("components/Drawer.tsx", "utf8");

  assert.equal(source.includes("item.stability"), false);
  assert.equal(source.includes("稳定"), false);
});

test("library display tags never duplicate an existing hash prefix", async () => {
  const compiledDir = join(process.cwd(), ".next-test");
  const modulePath = join(compiledDir, "library-tags.mjs");
  const source = await readFile(join(process.cwd(), "lib", "library-tags.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  await mkdir(compiledDir, { recursive: true });
  await writeFile(modulePath, compiled, "utf8");

  const { formatDisplayTag, formatDisplayTags } = await import(pathToFileURL(modulePath).href);

  assert.equal(formatDisplayTag("#遮挡"), "#遮挡");
  assert.equal(formatDisplayTag("空间"), "#空间");
  assert.equal(formatDisplayTags(["#遮挡", "空间"], "备用"), "#遮挡 #空间");
});
