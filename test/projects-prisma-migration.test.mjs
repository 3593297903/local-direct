import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  mapAnalysisResultToProjectCreateInput,
  mapPrismaProjectToProjectSummary,
} from "../scripts/project-prisma-mapper.mjs";

test("project mapper converts an analysis result into Prisma project and shot inputs", () => {
  const result = {
    title: "雨夜旧照",
    optimizedScript: "优化后的文案",
    contentType: "剧情",
    style: "悬疑电影感",
    duration: "15秒",
    storyboard: [
      {
        shotNumber: 1,
        scene: "雨夜街道",
        visual: "男人拿着旧照片停下脚步",
        shotType: "特写",
        cameraMovement: "缓慢推进",
        emotion: "疑惑",
        transition: "硬切",
        firstFramePrompt: "雨夜街道第一帧",
        videoPrompt: "雨夜街道视频提示词",
        lastFramePrompt: "雨夜街道尾帧",
        negativePrompt: "不要水印",
      },
    ],
  };

  const mapped = mapAnalysisResultToProjectCreateInput({
    userId: "00000000-0000-0000-0000-000000000001",
    originalScript: "原始文案",
    result,
  });

  assert.equal(mapped.project.title, "雨夜旧照");
  assert.equal(mapped.project.userId, "00000000-0000-0000-0000-000000000001");
  assert.equal(mapped.project.contentType, "剧情");
  assert.equal(mapped.shots.length, 1);
  assert.equal(mapped.shots[0].shotNumber, 1);
  assert.equal(mapped.shots[0].cameraMovement, "缓慢推进");
});

test("project mapper returns frontend-compatible project summaries", () => {
  const summary = mapPrismaProjectToProjectSummary({
    id: "project-1",
    title: "雨夜旧照",
    contentType: "剧情",
    style: "悬疑电影感",
    duration: "15秒",
    status: "draft",
    createdAt: new Date("2026-06-15T05:00:00.000Z"),
  });

  assert.deepEqual(summary, {
    id: "project-1",
    title: "雨夜旧照",
    content_type: "剧情",
    style: "悬疑电影感",
    duration: "15秒",
    status: "draft",
    created_at: "2026-06-15T05:00:00.000Z",
  });
});

test("NestJS projects module uses JWT user ownership with Prisma-backed service", () => {
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const module = readFileSync("apps/api/src/modules/projects/projects.module.ts", "utf8");
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");

  assert.match(controller, /UseGuards\(JwtAuthGuard\)/);
  assert.match(controller, /@Req\(\) request/);
  assert.doesNotMatch(controller, /@Query\("userId"\)/);
  assert.match(controller, /ProjectsService/);
  assert.match(controller, /listProjects\(request\.user\.id\)/);
  assert.match(controller, /createProject\(request\.user\.id, body\)/);
  assert.doesNotMatch(controller, /Project module skeleton/);
  assert.match(service, /prisma\.project\.findMany/);
  assert.match(service, /prisma\.project\.create/);
  assert.match(service, /createProject\(userId: string, input: CreateProjectDto\)/);
  assert.doesNotMatch(service, /input\.userId/);
  assert.doesNotMatch(dto, /userId!:/);
  assert.match(module, /imports: \[AuthModule\]/);
  assert.match(module, /providers: \[ProjectsService\]/);
});
