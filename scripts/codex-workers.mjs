import { spawn } from "node:child_process";
import path from "node:path";

const rootDir = process.cwd();
const workers = [
  ["season", "season-pack-codex-worker.mjs"],
  ["render-pack", "video-prompt-pack-codex-worker.mjs"],
  ["single-render", "video-prompt-codex-worker.mjs"],
  ["segment-patch", "batch-segment-repair-codex-worker.mjs"],
  ["coverage-judge", "event-coverage-codex-worker.mjs"],
  ["prompt-safety", "prompt-safety-codex-worker.mjs"],
  ["storyboard", "storyboard-codex-worker.mjs"],
  ["visual-asset", "visual-asset-codex-worker.mjs"],
];

const children = new Set();
let stopping = false;

for (const [name, fileName] of workers) {
  const child = spawn(process.execPath, [path.join(rootDir, "scripts", fileName)], {
    cwd: rootDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  pipeWithPrefix(child.stdout, name, false);
  pipeWithPrefix(child.stderr, name, true);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[${name}] worker stopped unexpectedly (code=${code ?? "none"}, signal=${signal || "none"}).`);
    }
  });
  child.on("error", (error) => {
    console.error(`[${name}] could not start: ${error.message}`);
  });
}

console.log(`Started ${workers.length} Local Director Codex workers in one terminal.`);
console.log("Press Ctrl+C to stop all workers.");

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

function pipeWithPrefix(stream, name, isError) {
  let pending = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) writeLine(name, line, isError);
  });
  stream?.on("end", () => {
    if (pending) writeLine(name, pending, isError);
  });
}

function writeLine(name, line, isError) {
  const output = `[${name}] ${line}\n`;
  (isError ? process.stderr : process.stdout).write(output);
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log("Stopping Local Director Codex workers...");
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 250).unref();
}
