import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });

const require = createRequire(import.meta.url);
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWorkspaceAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    return path.resolve(`${request.slice(2)}.ts`);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require("ts-node/register/transpile-only");

const { mapAnalysisResultToNestProjectBody } = require("../lib/nest-projects-proxy.ts");

test("project save mapping fills required metadata for compact season pack episodes", () => {
  const body = mapAnalysisResultToNestProjectBody({
    originalScript: "第1集《七天期限后的第一夜》：父亲看到发布会回放，决定带孩子投案。",
    result: {
      optimizedScript: "第1集《七天期限后的第一夜》：发布会回放进入家庭，父亲决定带孩子投案。",
      workflow: {
        fullVideoPrompt: "短剧第1集《七天期限后的第一夜》，约13秒。",
        fullNegativePrompt: "避免乱码和空白。",
      },
      storyboard: [
        {
          shotNumber: 1,
          timeRange: "0s-4s",
          scene: "昏暗客厅",
          visual: "旧电视播放发布会回放。",
          shotType: "中景",
          composition: "电视机在前景。",
          cameraMovement: "固定",
          lighting: "冷白电视光",
          sound: "电视杂音",
          dialogue: "无",
          emotion: "压抑",
          transition: "硬切",
          shotPurpose: "承接上一集",
          firstFramePrompt: "昏暗客厅，旧电视播放发布会。",
          videoPrompt: "昏暗客厅里，旧电视播放发布会回放。",
          lastFramePrompt: "父亲看向孩子。",
          negativePrompt: "避免乱码。",
        },
      ],
    },
  });

  assert.equal(body.title, "第1集｜七天期限后的第一夜");
  assert.equal(body.contentType, "短剧 / 通用");
  assert.equal(body.duration, "4秒");
  assert.equal(body.style, "通用");
});

test("project save mapping does not persist poisoned full video prompt text", () => {
  const body = mapAnalysisResultToNestProjectBody({
    originalScript: "第1集：测试。",
    fullVideoPrompt: "undefined：围绕原文案核心事件。\n总时长：undefined",
    result: {
      title: "第1集｜测试",
      contentType: "短剧 / 通用",
      duration: "15秒",
      style: "现实主义",
      optimizedScript: "第1集测试文案。",
      workflow: {
        fullVideoPrompt: "核心主题\n\n第1集测试。\n\n技术参数\n\n总时长：15秒",
        fullNegativePrompt: "避免乱码。",
      },
      storyboard: [
        {
          shotNumber: 1,
          timeRange: "0s-4s",
          scene: "室内",
          visual: "人物看向窗外。",
          shotType: "中景",
          composition: "人物在左侧。",
          cameraMovement: "固定",
          lighting: "自然光",
          sound: "环境声",
          dialogue: "无",
          emotion: "克制",
          transition: "硬切",
          shotPurpose: "建立情绪",
          firstFramePrompt: "室内人物。",
          videoPrompt: "人物看向窗外。",
          lastFramePrompt: "窗外光线。",
          negativePrompt: "避免乱码。",
        },
      ],
    },
  });

  assert.doesNotMatch(body.fullVideoPrompt, /undefined/);
  assert.match(body.fullVideoPrompt, /第1集测试/);
});
