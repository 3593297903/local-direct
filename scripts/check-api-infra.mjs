import { spawnSync } from "node:child_process";
import net from "node:net";

const jsonMode = process.argv.includes("--json");
const strictMode = process.argv.includes("--strict");

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

function checkTcp(name, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (ok, detail) => {
      socket.destroy();
      resolve({ name, ok, detail });
    };
    socket.setTimeout(900);
    socket.once("connect", () => done(true, `127.0.0.1:${port} is reachable`));
    socket.once("timeout", () => done(false, `127.0.0.1:${port} timed out`));
    socket.once("error", (error) => done(false, error.message));
  });
}

async function main() {
  const docker = run("docker", ["--version"]);
  const compose = run("docker", ["compose", "version"]);
  const postgres = await checkTcp("postgres", 5432);
  const redis = await checkTcp("redis", 6379);

  const checks = [
    {
      name: "docker",
      ok: docker.ok,
      detail: docker.ok ? docker.stdout : docker.error || docker.stderr || "docker command not found",
    },
    {
      name: "docker compose",
      ok: compose.ok,
      detail: compose.ok ? compose.stdout : compose.error || compose.stderr || "docker compose command failed",
    },
    postgres,
    redis,
  ];

  const nextCommands = [
    "npm run docker:up",
    "npm run prisma:migrate",
    "npm run library:import",
    "npm run api:dev",
  ];

  const result = {
    ok: checks.every((check) => check.ok),
    checks,
    nextCommands,
    notes: [
      "docker compose starts local postgres and redis from docker-compose.yml.",
      "prisma migrate creates the PostgreSQL schema.",
      "library:import loads data/knowledge-items.json into PostgreSQL.",
    ],
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log("API infrastructure check");
    for (const check of checks) {
      console.log(`${check.ok ? "OK" : "MISSING"} ${check.name}: ${check.detail}`);
    }
    console.log("\nRecommended next commands:");
    for (const command of nextCommands) console.log(`- ${command}`);
  }

  if (strictMode && !result.ok) process.exitCode = 1;
}

main().catch((error) => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  } else {
    console.error(error);
  }
  if (strictMode) process.exitCode = 1;
});
