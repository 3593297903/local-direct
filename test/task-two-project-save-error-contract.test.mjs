import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("project save exposes stable structured error codes and request ids", () => {
  const root = process.cwd();
  const contract = readFileSync(path.join(root, "lib", "project-save-contract.ts"), "utf8");
  const proxy = readFileSync(path.join(root, "lib", "nest-projects-proxy.ts"), "utf8");
  const controller = readFileSync(
    path.join(root, "apps", "api", "src", "modules", "projects", "projects.controller.ts"),
    "utf8",
  );
  for (const code of [
    "PROJECT_LOCK_BUSY",
    "PROJECT_API_UNAVAILABLE",
    "PROJECT_VALIDATION_FAILED",
    "PROJECT_DB_SAVE_FAILED",
    "PROJECT_VERSION_CONFLICT",
  ]) {
    assert.match(contract, new RegExp(code));
  }
  assert.match(contract, /retryable/);
  assert.match(contract, /errorCode/);
  assert.match(contract, /requestId/);
  assert.match(proxy, /mapProjectSaveFailure/);
  assert.match(proxy, /PROJECT_SAVE_PUBLIC_MESSAGES/);
  assert.match(proxy, /localhost:4100\/api/);
  assert.match(controller, /requestId/);
});

test("file job HTTP routes expose lease and storage error contracts", () => {
  const helper = readFileSync(path.join(process.cwd(), "lib", "file-job-route-error.ts"), "utf8");
  assert.match(helper, /JOB_LEASE_LOST:\s*409/);
  assert.match(helper, /JOB_STORAGE_BUSY:\s*503/);
  assert.match(helper, /errorCode/);
});
