import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const modulePath = join(compiledDir, "rate-limit.mjs");
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
await compileModule(join(process.cwd(), "lib", "rate-limit.ts"), modulePath);

test("rate limiter blocks requests after the limit inside a window", async () => {
  const { checkRateLimit, resetRateLimit } = await import(moduleUrl);
  resetRateLimit();

  assert.equal(checkRateLimit({ key: "ip-1", limit: 2, windowMs: 1000 }).allowed, true);
  assert.equal(checkRateLimit({ key: "ip-1", limit: 2, windowMs: 1000 }).allowed, true);
  const third = checkRateLimit({ key: "ip-1", limit: 2, windowMs: 1000 });

  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
});
