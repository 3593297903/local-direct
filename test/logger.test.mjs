import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const modulePath = join(compiledDir, "logger.mjs");
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
await compileModule(join(process.cwd(), "lib", "logger.ts"), modulePath);

test("logger sanitizes sensitive fields recursively", async () => {
  const { sanitizeLogValue } = await import(moduleUrl);

  const sanitized = sanitizeLogValue({
    username: "admin",
    password: "example-password",
    nested: {
      apiKey: "secret-key",
      cookie: "session=value",
      safe: "visible",
    },
  });

  assert.deepEqual(sanitized, {
    username: "admin",
    password: "[redacted]",
    nested: {
      apiKey: "[redacted]",
      cookie: "[redacted]",
      safe: "visible",
    },
  });
});

test("logger writes structured JSON entries", async () => {
  const { logger } = await import(moduleUrl);
  const originalInfo = console.info;
  const originalLogLevel = process.env.LOG_LEVEL;
  let line = "";

  try {
    process.env.LOG_LEVEL = "debug";
    console.info = (value) => {
      line = String(value);
    };

    logger.info("unit_test_event", {
      requestId: "req_test",
      password: "secret",
      count: 2,
    });

    const parsed = JSON.parse(line);
    assert.equal(parsed.level, "info");
    assert.equal(parsed.event, "unit_test_event");
    assert.equal(parsed.requestId, "req_test");
    assert.equal(parsed.password, "[redacted]");
    assert.equal(parsed.count, 2);
    assert.match(parsed.time, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    console.info = originalInfo;
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  }
});
