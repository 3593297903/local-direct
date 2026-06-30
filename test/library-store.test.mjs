import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const modulePath = join(compiledDir, "library-store.mjs");
const moduleUrl = pathToFileURL(modulePath).href;

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
await compileModule(join(process.cwd(), "lib", "knowledge.ts"), join(compiledDir, "knowledge.mjs"));
await compileModule(join(process.cwd(), "lib", "library-store.ts"), modulePath, [["./knowledge", "./knowledge.mjs"]]);

test("merged knowledge items let local items override defaults by id", async () => {
  const { getMergedKnowledgeItems, writeLocalKnowledgeItems } = await import(moduleUrl);
  const root = join(process.cwd(), ".tmp-library-test");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  await writeLocalKnowledgeItems([
    {
      id: "transition-shadow-cover",
      type: "transition",
      category: "custom transition",
      name: "Uploaded shadow transition",
      description: "Local override description",
      prompt: "Local override prompt",
      tags: ["custom"],
      stability: 99,
      useCase: "Local admin editing",
      previewUrl: "/previews/demo.gif",
      previewMimeType: "image/gif",
    },
  ], root);

  const merged = await getMergedKnowledgeItems(root);
  const item = merged.find((entry) => entry.id === "transition-shadow-cover");
  assert.equal(item.name, "Uploaded shadow transition");
  assert.equal(item.previewUrl, "/previews/demo.gif");
});

test("deleting a local knowledge item removes its preview file and generated poster", async () => {
  const { deleteLocalKnowledgeItem, posterDirPath, previewDirPath, writeLocalKnowledgeItems } = await import(moduleUrl);
  const root = join(process.cwd(), ".tmp-library-delete-test");
  await rm(root, { recursive: true, force: true });
  await mkdir(previewDirPath(root), { recursive: true });
  await mkdir(posterDirPath(root), { recursive: true });
  await writeFile(join(previewDirPath(root), "demo.mp4"), "preview");
  await writeFile(join(posterDirPath(root), "demo.jpg"), "poster");

  await writeLocalKnowledgeItems([
    {
      id: "camera-demo",
      type: "camera_movement",
      category: "camera",
      name: "Demo camera",
      description: "description",
      prompt: "prompt",
      tags: ["demo"],
      stability: 90,
      useCase: "use",
      previewUrl: "/previews/demo.mp4",
      previewMimeType: "video/mp4",
    },
  ], root);

  const result = await deleteLocalKnowledgeItem("camera-demo", root);

  assert.equal(result.deleted?.id, "camera-demo");
  assert.equal(result.items.length, 0);
  await assert.rejects(() => access(join(previewDirPath(root), "demo.mp4")));
  await assert.rejects(() => access(join(posterDirPath(root), "demo.jpg")));
});

test("deleting one copied local item keeps shared preview files until the last reference is gone", async () => {
  const { deleteLocalKnowledgeItem, posterDirPath, previewDirPath, writeLocalKnowledgeItems } = await import(moduleUrl);
  const root = join(process.cwd(), ".tmp-library-shared-delete-test");
  await rm(root, { recursive: true, force: true });
  await mkdir(previewDirPath(root), { recursive: true });
  await mkdir(posterDirPath(root), { recursive: true });
  await writeFile(join(previewDirPath(root), "shared.mp4"), "preview");
  await writeFile(join(posterDirPath(root), "shared.jpg"), "poster");

  const shared = {
    type: "transition",
    category: "cut",
    description: "description",
    prompt: "prompt",
    tags: [],
    stability: 90,
    useCase: "use",
    previewUrl: "/previews/shared.mp4",
    previewMimeType: "video/mp4",
  };
  await writeLocalKnowledgeItems([
    { ...shared, id: "transition-original", name: "Original", order: 1 },
    { ...shared, id: "transition-copy", name: "Copy", order: 2 },
  ], root);

  await deleteLocalKnowledgeItem("transition-copy", root);
  await access(join(previewDirPath(root), "shared.mp4"));
  await access(join(posterDirPath(root), "shared.jpg"));

  await deleteLocalKnowledgeItem("transition-original", root);
  await assert.rejects(() => access(join(previewDirPath(root), "shared.mp4")));
  await assert.rejects(() => access(join(posterDirPath(root), "shared.jpg")));
});

test("new local knowledge items get the next order for their type", async () => {
  const { readLocalKnowledgeItems, upsertLocalKnowledgeItem, writeLocalKnowledgeItems } = await import(moduleUrl);
  const root = join(process.cwd(), ".tmp-library-order-test");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  await writeLocalKnowledgeItems([
    {
      id: "transition-one",
      type: "transition",
      category: "cut",
      name: "One",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 1,
      useCase: "use",
    },
    {
      id: "transition-three",
      type: "transition",
      category: "cut",
      name: "Three",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 3,
      useCase: "use",
    },
    {
      id: "shot-one",
      type: "shot",
      category: "shot",
      name: "Shot",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 1,
      useCase: "use",
    },
  ], root);

  await upsertLocalKnowledgeItem({
    id: "transition-new",
    type: "transition",
    category: "cut",
    name: "New",
    description: "description",
    prompt: "prompt",
    tags: [],
    stability: 90,
    useCase: "use",
  }, root);

  const localItems = await readLocalKnowledgeItems(root);
  assert.equal(localItems.find((item) => item.id === "transition-new")?.order, 4);
});

test("moving a local knowledge item to another type appends it to the target type", async () => {
  const { readLocalKnowledgeItems, upsertLocalKnowledgeItem, writeLocalKnowledgeItems } = await import(moduleUrl);
  const root = join(process.cwd(), ".tmp-library-move-type-test");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  await writeLocalKnowledgeItems([
    {
      id: "transition-one",
      type: "transition",
      category: "cut",
      name: "One",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 1,
      useCase: "use",
    },
    {
      id: "transition-two",
      type: "transition",
      category: "cut",
      name: "Two",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 2,
      useCase: "use",
    },
    {
      id: "shot-one",
      type: "shot",
      category: "shot",
      name: "Shot One",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 1,
      useCase: "use",
    },
    {
      id: "shot-two",
      type: "shot",
      category: "shot",
      name: "Shot Two",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 2,
      useCase: "use",
    },
  ], root);

  await upsertLocalKnowledgeItem({
    id: "transition-one",
    type: "shot",
    category: "shot",
    name: "One",
    description: "description",
    prompt: "prompt",
    tags: [],
    stability: 90,
    order: 1,
    useCase: "use",
  }, root);

  const localItems = await readLocalKnowledgeItems(root);
  const transitions = localItems.filter((item) => item.type === "transition");
  const shots = localItems.filter((item) => item.type === "shot");

  assert.deepEqual(transitions.map((item) => [item.id, item.order]), [["transition-two", 1]]);
  assert.deepEqual(shots.map((item) => [item.id, item.order]), [
    ["shot-one", 1],
    ["shot-two", 2],
    ["transition-one", 3],
  ]);
});

test("bulk deleting local knowledge items compacts order for remaining items of the same type", async () => {
  const { deleteLocalKnowledgeItems, readLocalKnowledgeItems, writeLocalKnowledgeItems } = await import(moduleUrl);
  const root = join(process.cwd(), ".tmp-library-bulk-delete-test");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  await writeLocalKnowledgeItems([
    {
      id: "transition-one",
      type: "transition",
      category: "cut",
      name: "One",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 1,
      useCase: "use",
    },
    {
      id: "transition-two",
      type: "transition",
      category: "cut",
      name: "Two",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 2,
      useCase: "use",
    },
    {
      id: "transition-three",
      type: "transition",
      category: "cut",
      name: "Three",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 3,
      useCase: "use",
    },
    {
      id: "shot-one",
      type: "shot",
      category: "shot",
      name: "Shot",
      description: "description",
      prompt: "prompt",
      tags: [],
      stability: 90,
      order: 9,
      useCase: "use",
    },
  ], root);

  const result = await deleteLocalKnowledgeItems(["transition-two"], root);
  const localItems = await readLocalKnowledgeItems(root);

  assert.deepEqual(result.deleted.map((item) => item.id), ["transition-two"]);
  assert.equal(localItems.find((item) => item.id === "transition-one")?.order, 1);
  assert.equal(localItems.find((item) => item.id === "transition-three")?.order, 2);
  assert.equal(localItems.find((item) => item.id === "shot-one")?.order, 9);
});

test("uploaded file names are sanitized and keep safe extensions", async () => {
  const { sanitizeUploadName } = await import(moduleUrl);
  assert.equal(sanitizeUploadName("demo clip!!.mp4"), "demo-clip.mp4");
  assert.equal(sanitizeUploadName("../../bad.exe"), "preview.bin");
  assert.equal(sanitizeUploadName("demo.GIF"), "demo.gif");
});

test("preview buffers save without using Request formData parsing", async () => {
  const { previewDirPath, savePreviewBuffer } = await import(moduleUrl);
  const root = join(process.cwd(), ".tmp-library-buffer-test");
  await rm(root, { recursive: true, force: true });

  try {
    const saved = await savePreviewBuffer(Buffer.from("fake-image"), "测试图片.png", "image/png", root);

    assert.match(saved.previewUrl, /^\/previews\/\d+-/);
    assert.equal(saved.previewMimeType, "image/png");
    assert.equal(saved.posterUrl, undefined);
    await access(join(previewDirPath(root), saved.previewUrl.replace("/previews/", "")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview uploads reject files over the configured size limit", async () => {
  const { MAX_PREVIEW_UPLOAD_BYTES, validatePreviewFile } = await import(moduleUrl);
  const file = {
    name: "large.mp4",
    type: "video/mp4",
    size: MAX_PREVIEW_UPLOAD_BYTES + 1,
  };

  assert.throws(() => validatePreviewFile(file), /文件不能超过/);
});
