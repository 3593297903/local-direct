import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledDir = join(process.cwd(), ".next-test");
const modulePath = join(compiledDir, "admin-auth.mjs");
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
await compileModule(join(process.cwd(), "lib", "admin-auth.ts"), modulePath);

test("admin auth does not keep hardcoded default credentials", async () => {
  const authSource = await readFile(join(process.cwd(), "lib", "admin-auth.ts"), "utf8");
  const loginRouteSource = await readFile(join(process.cwd(), "app", "api", "admin", "login", "route.ts"), "utf8");

  assert.doesNotMatch(authSource, /157990|DEFAULT_ADMIN_PASSWORD|DEFAULT_ADMIN_USERNAME/);
  assert.doesNotMatch(loginRouteSource, /DEFAULT_ADMIN_PASSWORD|DEFAULT_ADMIN_USERNAME/);
  assert.match(loginRouteSource, /ADMIN_LIBRARY_USERNAME/);
  assert.match(loginRouteSource, /ADMIN_LIBRARY_PASSWORD/);
});

test("admin auth allows local use when no token is configured", async () => {
  const { isAdminRequestAuthorized } = await import(moduleUrl);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const request = new Request("http://localhost/api/admin/library");
  try {
    assert.equal(isAdminRequestAuthorized(request, "", ""), true);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

test("admin auth rejects production requests when no token is configured", async () => {
  const { isAdminRequestAuthorized } = await import(moduleUrl);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const request = new Request("http://localhost/api/admin/library");
  try {
    assert.equal(isAdminRequestAuthorized(request, "", ""), false);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

test("admin auth requires matching configured token", async () => {
  const { isAdminRequestAuthorized } = await import(moduleUrl);
  const allowed = new Request("http://localhost/api/admin/library", {
    headers: { "x-admin-token": "secret" },
  });
  const denied = new Request("http://localhost/api/admin/library", {
    headers: { "x-admin-token": "wrong" },
  });

  assert.equal(isAdminRequestAuthorized(allowed, "secret"), true);
  assert.equal(isAdminRequestAuthorized(denied, "secret"), false);
});

test("admin auth accepts a valid local admin session cookie when credentials are configured", async () => {
  const { ADMIN_SESSION_COOKIE, createAdminSessionCookie, isAdminRequestAuthorized } = await import(moduleUrl);
  const cookie = createAdminSessionCookie("admin-password", "test-secret");
  const request = new Request("http://localhost/api/admin/library", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${cookie}` },
  });

  assert.equal(isAdminRequestAuthorized(request, "secret-token", "admin-password", "test-secret"), true);
});

test("admin auth rejects an invalid local admin session cookie", async () => {
  const { ADMIN_SESSION_COOKIE, isAdminRequestAuthorized } = await import(moduleUrl);
  const request = new Request("http://localhost/api/admin/library", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=bad` },
  });

  assert.equal(isAdminRequestAuthorized(request, "secret-token", "admin-password", "test-secret"), false);
});
