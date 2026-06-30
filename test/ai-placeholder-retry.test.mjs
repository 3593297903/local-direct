import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const modulePath = join(compiledDir, "ai-placeholder-retry.mjs");
const moduleUrl = pathToFileURL(modulePath).href;

await mkdir(compiledDir, { recursive: true });
let source = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");
source = source
  .replace('import { buildMockAnalysis } from "@/lib/mock";', "const buildMockAnalysis = () => ({});")
  .replace(
    'import { AI_VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT } from "@/lib/prompt-optimizer-skill";',
    'const AI_VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT = "system";',
  )
  .replace(
    'import { durationSince, logger } from "@/lib/logger";',
    'const durationSince = () => 0; const logger = { info() {}, warn() {}, error() {}, debug() {} };',
  );
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;
await writeFile(modulePath, compiled, "utf8");

test("template placeholder errors include the exact result path and matched text", async () => {
  const { assertNoTemplatePlaceholders } = await import(moduleUrl);

  assert.throws(
    () =>
      assertNoTemplatePlaceholders({
        workflow: {
          finalPromptPackage: `镜头提示词已经完整，负面提示词${"\u540c\u4e0a"}`,
        },
      }),
    (error) => {
      assert.match(error.message, /workflow\.finalPromptPackage/);
      assert.match(error.message, /\u540c\u4e0a/);
      return true;
    },
  );
});

test("placeholder retry runs once and passes a stronger retry instruction", async () => {
  const { TemplatePlaceholderError, runWithTemplatePlaceholderRetry } = await import(moduleUrl);
  let calls = 0;
  let retryInstruction = "";

  const result = await runWithTemplatePlaceholderRetry(
    async (_attempt, instruction) => {
      calls += 1;
      if (calls === 1) {
        throw new TemplatePlaceholderError("storyboard[0].videoPrompt", "\u7565", "\u7565");
      }
      retryInstruction = instruction || "";
      return "ok";
    },
    { requestId: "test_request", provider: "test-provider" },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.match(retryInstruction, /storyboard\[0\]\.videoPrompt/);
  assert.match(retryInstruction, /\u7565/);
});

test("placeholder retry stops after five retries to avoid token runaway", async () => {
  const { TemplatePlaceholderError, runWithTemplatePlaceholderRetry } = await import(moduleUrl);
  let calls = 0;

  await assert.rejects(
    runWithTemplatePlaceholderRetry(
      async () => {
        calls += 1;
        throw new TemplatePlaceholderError("workflow.finalPromptPackage", "\u540c\u4e0a", "\u540c\u4e0a");
      },
      { requestId: "test_request", provider: "test-provider" },
    ),
    /workflow\.finalPromptPackage/,
  );

  assert.equal(calls, 6);
});

test("placeholder repair expands optional final prompt package from complete workflow fields", async () => {
  const { assertNoTemplatePlaceholders, repairTemplatePlaceholders } = await import(moduleUrl);
  const fullVideoPrompt = "\u672a\u6765\u53a8\u623f\u91cc\uff0c\u5973\u6027\u89d2\u8272\u4e0eAI\u5c0f\u673a\u5668\u4eba\u5171\u540c\u51c6\u5907\u65e9\u9910\u3002";

  const repaired = repairTemplatePlaceholders({
    title: "\u6d4b\u8bd5\u7247\u6bb5",
    contentType: "\u79d1\u5e7b\u65e5\u5e38",
    duration: "15\u79d2",
    style: "\u6e29\u6696\u79d1\u6280\u611f",
    diagnosis: [],
    optimizedScript: "\u5b8c\u6574\u89c6\u9891\u63d0\u793a\u8bcd",
    recommendedItems: [],
    editingNotes: [],
    workflow: {
      fullVideoPrompt,
      fullNegativePrompt: "\u4e0d\u8981\u6050\u6016\uff0c\u4e0d\u8981\u8840\u8165\uff0c\u4e0d\u8981\u5b57\u5e55\u6c34\u5370\u3002",
      shotPromptText: "\u6838\u5fc3\u4e3b\u9898\n\n\u6e29\u6696\u79d1\u6280\u751f\u6d3b\n\n\u6280\u672f\u53c2\u6570\n\n\u603b\u65f6\u957f\uff1a15\u79d2",
      finalPromptPackage: "\u6838\u5fc3\u4e3b\u9898\u540c\u4e0a\uff0c\u5f71\u5149\u4fdd\u6301\uff0c\u6295\u5f71\u7a33\u5b9a\u8d1f\u9762\u63d0\u793a\u8bcd\uff1a\u6050\u6016\u3001\u8840\u8165\u3002",
    },
    storyboard: [
      {
        shotNumber: 1,
        timeRange: "0.0s-4.0s",
        scene: "\u672a\u6765\u53a8\u623f",
        visual: "\u67d4\u548c\u6668\u5149\u4e2d\uff0cAI\u5c0f\u673a\u5668\u4eba\u5728\u684c\u9762\u79fb\u52a8\u3002",
        shotType: "\u4e2d\u666f",
        cameraMovement: "\u7f13\u6162\u63a8\u8fdb",
        emotion: "\u6e29\u6696",
        transition: "\u786c\u5207",
        firstFramePrompt: "\u672a\u6765\u53a8\u623f\u5168\u666f\uff0c\u67d4\u548c\u6668\u5149\uff0cAI\u5c0f\u673a\u5668\u4eba\u5728\u684c\u9762\u5f85\u673a\u3002",
        videoPrompt: "\u672a\u6765\u53a8\u623f\u91cc\uff0cAI\u5c0f\u673a\u5668\u4eba\u6cbf\u684c\u9762\u7f13\u6162\u79fb\u52a8\uff0c\u5973\u6027\u89d2\u8272\u5b89\u9759\u51c6\u5907\u65e9\u9910\u3002",
        lastFramePrompt: "\u753b\u9762\u505c\u5728AI\u5c0f\u673a\u5668\u4eba\u9760\u8fd1\u9910\u76d8\u7684\u77ac\u95f4\uff0c\u6668\u5149\u4fdd\u6301\u67d4\u548c\u3002",
        negativePrompt: "\u4e0d\u8981\u6050\u6016\uff0c\u4e0d\u8981\u8840\u8165\uff0c\u4e0d\u8981\u5b57\u5e55\u6c34\u5370\u3002",
      },
    ],
  });

  assert.doesNotThrow(() => assertNoTemplatePlaceholders(repaired));
  assert.equal(repaired.workflow.fullVideoPrompt, fullVideoPrompt);
  assert.doesNotMatch(repaired.workflow.finalPromptPackage, /\u540c\u4e0a/);
  assert.match(repaired.workflow.finalPromptPackage, /\u672a\u6765\u53a8\u623f/);
});

test("AI network fetch retry runs once and then returns a response", async () => {
  const { fetchAiProvider } = await import(moduleUrl);
  const originalFetch = globalThis.fetch;
  const originalDelay = process.env.AI_NETWORK_RETRY_DELAY_MS;
  let calls = 0;

  try {
    process.env.AI_NETWORK_RETRY_DELAY_MS = "0";
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    };

    const response = await fetchAiProvider("https://api.deepseek.com/chat/completions", { method: "POST" }, {
      requestId: "test_request",
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
    });

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDelay === undefined) delete process.env.AI_NETWORK_RETRY_DELAY_MS;
    else process.env.AI_NETWORK_RETRY_DELAY_MS = originalDelay;
  }
});

test("AI network fetch retry stops after one retry with a clear diagnostic error", async () => {
  const { AIProviderNetworkError, fetchAiProvider } = await import(moduleUrl);
  const originalFetch = globalThis.fetch;
  const originalDelay = process.env.AI_NETWORK_RETRY_DELAY_MS;
  let calls = 0;

  try {
    process.env.AI_NETWORK_RETRY_DELAY_MS = "0";
    globalThis.fetch = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };

    await assert.rejects(
      fetchAiProvider("https://api.deepseek.com/chat/completions", { method: "POST" }, {
        requestId: "test_request",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
      }),
      (error) => {
        assert.equal(error instanceof AIProviderNetworkError, true);
        assert.match(error.message, /deepseek/);
        assert.match(error.message, /deepseek-v4-flash/);
        assert.match(error.message, /https:\/\/api\.deepseek\.com/);
        assert.match(error.message, /proxy|VPN|firewall|AI_BASE_URL/i);
        return true;
      },
    );

    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDelay === undefined) delete process.env.AI_NETWORK_RETRY_DELAY_MS;
    else process.env.AI_NETWORK_RETRY_DELAY_MS = originalDelay;
  }
});
