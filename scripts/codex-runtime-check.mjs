import {
  validateCodexRuntime,
  writeCodexRuntimeEnvironmentHealth,
  writeCodexWorkerHeartbeat,
} from "./codex-runtime-health.mjs";

const health = await validateCodexRuntime();
await writeCodexRuntimeEnvironmentHealth({ health });
await writeCodexWorkerHeartbeat({ workerName: "runtime-check", health });
if (health.status !== "healthy") {
  console.error("CODEX_SKILL_CONFIG_INVALID");
  for (const error of health.errors) console.error(`${error.path}: ${error.message}`);
  process.exitCode = 1;
} else {
  console.log(`Codex runtime healthy: ${health.codexVersion}; ${health.skillCount} skills checked.`);
}
