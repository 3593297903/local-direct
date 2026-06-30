import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  filterLibraryItemsForApi,
  mapKnowledgeItemToPrismaInput,
  mapPrismaLibraryItemToKnowledgeItem,
} from "../scripts/knowledge-item-prisma-mapper.mjs";

test("knowledge item mapper preserves frontend fields while converting Prisma enum values", () => {
  const item = {
    id: "local-camera-push",
    type: "camera_movement",
    category: "推进",
    name: "缓慢推进",
    description: "镜头缓慢靠近主体。",
    prompt: "缓慢推进，情绪递进。",
    tags: ["#推进", "#希望"],
    genre: "剧情",
    stability: 90,
    order: 7,
    useCase: "适合释然、温暖、希望感镜头。",
    avoid: "不适合强动作剪辑。",
    previewType: "camera",
    previewUrl: "/previews/camera-push.mp4",
    previewMimeType: "video/mp4",
    posterUrl: "/previews/posters/camera-push.jpg",
  };

  const prismaInput = mapKnowledgeItemToPrismaInput(item);
  assert.equal(prismaInput.type, "CAMERA_MOVEMENT");
  assert.equal(prismaInput.order, 7);
  assert.deepEqual(prismaInput.tags, ["#推进", "#希望"]);

  const apiItem = mapPrismaLibraryItemToKnowledgeItem({
    ...prismaInput,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(apiItem.type, "camera_movement");
  assert.equal(apiItem.name, "缓慢推进");
  assert.equal(apiItem.previewUrl, "/previews/camera-push.mp4");
});

test("library API filtering supports query and frontend type values", () => {
  const items = [
    {
      id: "a",
      type: "camera_movement",
      category: "推进",
      name: "缓慢推进",
      description: "温暖希望的推进镜头",
      prompt: "缓慢推进",
      tags: ["#温暖"],
      genre: "剧情",
      stability: 90,
      order: 1,
      useCase: "适合希望感",
    },
    {
      id: "b",
      type: "transition",
      category: "硬切",
      name: "硬切",
      description: "快速切换",
      prompt: "硬切",
      tags: ["#切换"],
      genre: "动作",
      stability: 90,
      order: 1,
      useCase: "适合动作节奏",
    },
  ];

  const filtered = filterLibraryItemsForApi(items, { q: "希望", type: "camera_movement" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "a");
});

test("NestJS library module uses Prisma-backed service instead of placeholder response", () => {
  const controller = readFileSync("apps/api/src/modules/library/library.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/library/library.service.ts", "utf8");
  const module = readFileSync("apps/api/src/modules/library/library.module.ts", "utf8");

  assert.match(controller, /@Query\("q"\)/);
  assert.match(controller, /LibraryService/);
  assert.doesNotMatch(controller, /postgres-placeholder/);
  assert.match(service, /prisma\.libraryItem\.findMany/);
  assert.match(module, /providers: \[LibraryService\]/);
});
