import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { atomicReplaceJson } from "./file-job-store";

export const CODEX_FINALIZATION_PROTOCOL_VERSION = 2 as const;
export const CODEX_FINAL_MANIFEST_FILE = "final-manifest.v2.json";
export const CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE = "FINALIZATION_V2_CREATE_PAUSED";

export function assertCodexFinalizationV2CreateEnabled() {
  const configured = String(process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED ?? "true").trim().toLowerCase();
  if (!["0", "false", "no", "off"].includes(configured)) return;
  const error = new Error("Protocol v2 Codex finalization job creation is temporarily paused") as Error & { code: string };
  error.name = "CodexFinalizationV2CreatePausedError";
  error.code = CODEX_FINALIZATION_V2_CREATE_PAUSED_CODE;
  throw error;
}

export type CodexFinalizationTaskClass = "season_pack" | "render_pack";
export type CodexFinalizationOutputKind =
  | "season_plan"
  | "episode_input"
  | "render_result"
  | "coverage_sidecar";

export type CodexFinalizationOutputFile = {
  relativePath: string;
  byteLength: number;
  sha256: string;
  kind: CodexFinalizationOutputKind;
};

export type CodexFinalManifestV2 = {
  protocolVersion: typeof CODEX_FINALIZATION_PROTOCOL_VERSION;
  jobId: string;
  taskClass: CodexFinalizationTaskClass;
  leaseId: string;
  fencingToken: number;
  sourceHash: string;
  contractHash?: string;
  segmentIndexes: number[];
  outputFiles: CodexFinalizationOutputFile[];
  resultHash: string;
  codexExitCode: 0;
  finalizedAt: string;
};

export type CodexFinalizedResultRef = {
  protocolVersion: typeof CODEX_FINALIZATION_PROTOCOL_VERSION;
  resultHash: string;
  relativePath: string;
  manifestRelativePath: string;
};

export type CodexFinalizationIdentity = {
  rootDir: string;
  namespace: string;
  jobId: string;
  taskClass: CodexFinalizationTaskClass;
  leaseId: string;
  fencingToken: number;
  sourceHash: string;
  contractHash?: string;
  segmentIndexes: number[];
  resultHash: string;
};

export type CodexFinalizationErrorCode =
  | "CODEX_PROCESS_FAILED"
  | "FINALIZATION_OUTPUT_MISSING"
  | "PACK_FINALIZATION_MISSING_SEGMENT"
  | "FINALIZATION_SCHEMA_INVALID"
  | "FINALIZATION_IDENTITY_MISMATCH"
  | "FINALIZATION_HASH_MISMATCH"
  | "FINALIZATION_ENCODING_INVALID"
  | "FINALIZATION_ATOMIC_REPLACE_FAILED"
  | "FINALIZATION_STALE_FENCE";

export class CodexJobFinalizationError extends Error {
  readonly code: CodexFinalizationErrorCode;

  constructor(code: CodexFinalizationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexJobFinalizationError";
    this.code = code;
  }
}

type OutputFileInput = {
  relativePath: string;
  kind: CodexFinalizationOutputKind;
};

type WriteFinalManifestInput = CodexFinalizationIdentity & {
  stagingDir: string;
  outputFiles: OutputFileInput[];
  codexExitCode: number;
  finalizedAt?: string;
};

type ReadFinalManifestInput = {
  directory: string;
  expected: Omit<CodexFinalizationIdentity, "rootDir" | "namespace"> & Partial<Pick<CodexFinalizationIdentity, "rootDir" | "namespace">>;
};

type ReadRecoverableFinalManifestInput = {
  directory: string;
  expected: Pick<CodexFinalizationIdentity,
    "jobId" | "taskClass" | "leaseId" | "fencingToken" | "sourceHash"
  > & Partial<Pick<CodexFinalizationIdentity, "contractHash" | "segmentIndexes">>;
};

type PublishFinalizedJobInput = CodexFinalizationIdentity & {
  stagingDir: string;
  retryDelaysMs?: readonly number[];
  renameImpl?: (source: string, destination: string) => Promise<void>;
};

type StableFinalizationFilesInput = {
  directory: string;
  relativePaths: string[];
  delayMs?: number;
  afterFirstSnapshot?: () => void | Promise<void>;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSIENT_WINDOWS_FILE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const FINALIZATION_RETRY_DELAYS_MS = [0, 50, 100, 200, 400, 800] as const;
const OUTPUT_KINDS = new Set<CodexFinalizationOutputKind>([
  "season_plan",
  "episode_input",
  "render_result",
  "coverage_sidecar",
]);

export async function createJobStagingDirectory(input: Pick<CodexFinalizationIdentity,
  "rootDir" | "namespace" | "jobId" | "leaseId" | "fencingToken"
>) {
  assertSafePathComponent(input.jobId, "jobId");
  assertSafePathComponent(input.leaseId, "leaseId");
  assertPositiveInteger(input.fencingToken, "fencingToken");
  const queueRoot = queueRootPath(input.rootDir, input.namespace);
  const stagingDir = assertPathInside(
    path.join(queueRoot, "staging"),
    path.join(queueRoot, "staging", input.jobId, `attempt-${input.fencingToken}-${input.leaseId}`),
  );
  await mkdir(stagingDir, { recursive: true });
  return stagingDir;
}

export async function writeFinalManifest(input: WriteFinalManifestInput) {
  if (input.codexExitCode !== 0) {
    throw new CodexJobFinalizationError(
      "CODEX_PROCESS_FAILED",
      `Codex process exited with code ${input.codexExitCode}`,
    );
  }
  validateIdentity(input);
  const stagingDir = assertFinalizationDirectory(input, input.stagingDir, "staging");
  const uniquePaths = new Set<string>();
  const normalizedFiles = input.outputFiles.map((output) => {
    const relativePath = normalizeRelativeOutputPath(output.relativePath);
    if (!OUTPUT_KINDS.has(output.kind)) {
      throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", `Unsupported final output kind: ${String(output.kind)}`);
    }
    if (relativePath === CODEX_FINAL_MANIFEST_FILE || uniquePaths.has(relativePath)) {
      throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", `Duplicate or reserved final output path: ${relativePath}`);
    }
    uniquePaths.add(relativePath);
    return { relativePath, kind: output.kind };
  });
  if (!normalizedFiles.length) {
    throw new CodexJobFinalizationError("FINALIZATION_OUTPUT_MISSING", "Finalization requires at least one output file");
  }

  const outputFiles = await Promise.all(normalizedFiles.map(async (output) => {
    const target = assertPathInside(stagingDir, path.join(stagingDir, ...output.relativePath.split("/")));
    let bytes: Buffer;
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size <= 0) throw new Error("not a non-empty file");
      bytes = await readFile(target);
    } catch (error) {
      throw new CodexJobFinalizationError(
        "FINALIZATION_OUTPUT_MISSING",
        `Finalization output is missing or empty: ${output.relativePath}`,
        { cause: error },
      );
    }
    return {
      ...output,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    };
  }));

  const manifest: CodexFinalManifestV2 = {
    protocolVersion: CODEX_FINALIZATION_PROTOCOL_VERSION,
    jobId: input.jobId,
    taskClass: input.taskClass,
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
    sourceHash: input.sourceHash,
    ...(input.contractHash ? { contractHash: input.contractHash } : {}),
    segmentIndexes: normalizeSegmentIndexes(input.segmentIndexes),
    outputFiles: outputFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    resultHash: input.resultHash,
    codexExitCode: 0,
    finalizedAt: input.finalizedAt || new Date().toISOString(),
  };
  const manifestPath = path.join(stagingDir, CODEX_FINAL_MANIFEST_FILE);
  await rm(manifestPath, { force: true });
  try {
    await atomicReplaceJson(manifestPath, manifest, {
      rootDir: stagingDir,
      retryDelaysMs: FINALIZATION_RETRY_DELAYS_MS,
    });
  } catch (error) {
    throw new CodexJobFinalizationError(
      "FINALIZATION_ATOMIC_REPLACE_FAILED",
      "Could not atomically write the finalization manifest",
      { cause: error },
    );
  }
  return manifest;
}

export async function readAndValidateFinalManifest(input: ReadFinalManifestInput) {
  const directory = path.resolve(input.directory);
  const manifestPath = assertPathInside(directory, path.join(directory, CODEX_FINAL_MANIFEST_FILE));
  let manifest: CodexFinalManifestV2;
  try {
    manifest = JSON.parse(await readStrictUtf8(manifestPath)) as CodexFinalManifestV2;
  } catch (error) {
    if (error instanceof CodexJobFinalizationError) throw error;
    throw new CodexJobFinalizationError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "FINALIZATION_OUTPUT_MISSING" : "FINALIZATION_SCHEMA_INVALID",
      "Finalization manifest is missing or invalid",
      { cause: error },
    );
  }
  validateManifestShape(manifest);
  validateManifestIdentity(manifest, input.expected);

  const seenPaths = new Set<string>();
  for (const output of manifest.outputFiles) {
    const relativePath = normalizeRelativeOutputPath(output.relativePath);
    if (seenPaths.has(relativePath) || relativePath === CODEX_FINAL_MANIFEST_FILE) {
      throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", `Duplicate or reserved final output path: ${relativePath}`);
    }
    seenPaths.add(relativePath);
    const target = assertPathInside(directory, path.join(directory, ...relativePath.split("/")));
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch (error) {
      throw new CodexJobFinalizationError(
        "FINALIZATION_OUTPUT_MISSING",
        `Manifest output is missing: ${relativePath}`,
        { cause: error },
      );
    }
    if (bytes.byteLength !== output.byteLength || sha256(bytes) !== output.sha256) {
      throw new CodexJobFinalizationError(
        "FINALIZATION_HASH_MISMATCH",
        `Manifest output hash does not match: ${relativePath}`,
      );
    }
  }
  return manifest;
}

export async function readAndValidateRecoverableFinalManifest(input: ReadRecoverableFinalManifestInput) {
  const parsed = await readStrictFinalizationJson(input.directory, CODEX_FINAL_MANIFEST_FILE);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization manifest must be an object");
  }
  const manifest = parsed as CodexFinalManifestV2;
  validateManifestShape(manifest);
  return readAndValidateFinalManifest({
    directory: input.directory,
    expected: {
      ...input.expected,
      ...(input.expected.contractHash
        ? { contractHash: input.expected.contractHash }
        : manifest.contractHash
          ? { contractHash: manifest.contractHash }
          : {}),
      segmentIndexes: input.expected.segmentIndexes || manifest.segmentIndexes,
      resultHash: manifest.resultHash,
    },
  });
}

export async function publishFinalizedJob(input: PublishFinalizedJobInput): Promise<CodexFinalizedResultRef> {
  validateIdentity(input);
  const queueRoot = queueRootPath(input.rootDir, input.namespace);
  const stagingDir = assertFinalizationDirectory(input, input.stagingDir, "staging");
  await readAndValidateFinalManifest({ directory: stagingDir, expected: input });
  const destination = assertPathInside(
    path.join(queueRoot, "results"),
    path.join(queueRoot, "results", input.jobId, input.resultHash),
  );
  const resultRef = buildFinalizedResultRef(input.jobId, input.resultHash);

  try {
    await stat(destination);
    await readAndValidateFinalManifest({ directory: destination, expected: input });
    return resultRef;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof CodexJobFinalizationError) throw error;
      throw new CodexJobFinalizationError("FINALIZATION_ATOMIC_REPLACE_FAILED", "Immutable result destination is invalid", { cause: error });
    }
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const retryDelays = input.retryDelaysMs?.length ? input.retryDelaysMs : FINALIZATION_RETRY_DELAYS_MS;
  const renameImpl = input.renameImpl || rename;
  let finalError: unknown;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt] > 0) {
      const jitter = Math.floor(Math.random() * 26);
      await wait(retryDelays[attempt] + jitter);
    }
    try {
      await renameImpl(stagingDir, destination);
      await readAndValidateFinalManifest({ directory: destination, expected: input });
      return resultRef;
    } catch (error) {
      finalError = error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        await readAndValidateFinalManifest({ directory: destination, expected: input });
        return resultRef;
      }
      if (!TRANSIENT_WINDOWS_FILE_CODES.has((error as NodeJS.ErrnoException).code || "") || attempt === retryDelays.length - 1) {
        break;
      }
    }
  }
  throw new CodexJobFinalizationError(
    "FINALIZATION_ATOMIC_REPLACE_FAILED",
    "Could not atomically publish the finalized Codex result",
    { cause: finalError },
  );
}

export function hashCanonicalJson(value: unknown) {
  return sha256(JSON.stringify(sortCanonicalValue(value)));
}

export async function readStrictFinalizationJson(directory: string, relativePath: string) {
  const root = path.resolve(directory);
  const normalized = normalizeRelativeOutputPath(relativePath);
  const target = assertPathInside(root, path.join(root, ...normalized.split("/")));
  let text: string;
  try {
    text = await readStrictUtf8(target);
  } catch (error) {
    if (error instanceof CodexJobFinalizationError) throw error;
    throw new CodexJobFinalizationError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "FINALIZATION_OUTPUT_MISSING" : "FINALIZATION_ENCODING_INVALID",
      `Finalization JSON is missing or not strict UTF-8: ${normalized}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CodexJobFinalizationError(
      "FINALIZATION_SCHEMA_INVALID",
      `Finalization JSON is invalid: ${normalized}`,
      { cause: error },
    );
  }
}

export async function assertFinalizationFilesStable(input: StableFinalizationFilesInput) {
  const directory = path.resolve(input.directory);
  const relativePaths = [...new Set(input.relativePaths.map(normalizeRelativeOutputPath))]
    .sort((left, right) => left.localeCompare(right));
  if (!relativePaths.length) {
    throw new CodexJobFinalizationError("FINALIZATION_OUTPUT_MISSING", "Finalization stability check has no outputs");
  }
  const first = await snapshotFinalizationFiles(directory, relativePaths);
  await input.afterFirstSnapshot?.();
  await wait(Math.max(0, input.delayMs ?? 25));
  const second = await snapshotFinalizationFiles(directory, relativePaths);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new CodexJobFinalizationError(
      "FINALIZATION_HASH_MISMATCH",
      "Finalization output changed between post-exit stability reads",
    );
  }
  return second;
}

function validateIdentity(identity: Omit<CodexFinalizationIdentity, "rootDir" | "namespace">) {
  assertSafePathComponent(identity.jobId, "jobId");
  assertSafePathComponent(identity.leaseId, "leaseId");
  assertPositiveInteger(identity.fencingToken, "fencingToken");
  if (identity.taskClass !== "season_pack" && identity.taskClass !== "render_pack") {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization taskClass is invalid");
  }
  if (!SHA256_PATTERN.test(identity.sourceHash) || !SHA256_PATTERN.test(identity.resultHash)) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization hashes must be SHA-256 values");
  }
  if (identity.contractHash && !SHA256_PATTERN.test(identity.contractHash)) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization contractHash must be a SHA-256 value");
  }
  normalizeSegmentIndexes(identity.segmentIndexes);
}

function validateManifestShape(manifest: CodexFinalManifestV2) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization manifest must be an object");
  }
  if (manifest.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION || manifest.codexExitCode !== 0) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization manifest protocol or Codex exit code is invalid");
  }
  validateIdentity(manifest);
  if (!Array.isArray(manifest.outputFiles) || !manifest.outputFiles.length) {
    throw new CodexJobFinalizationError("FINALIZATION_OUTPUT_MISSING", "Finalization manifest has no outputs");
  }
  for (const output of manifest.outputFiles) {
    if (!output || typeof output !== "object" || !OUTPUT_KINDS.has(output.kind)
      || !Number.isInteger(output.byteLength) || output.byteLength <= 0 || !SHA256_PATTERN.test(output.sha256)) {
      throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization output descriptor is invalid");
    }
  }
  if (!Number.isFinite(Date.parse(manifest.finalizedAt))) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization timestamp is invalid");
  }
}

function validateManifestIdentity(
  manifest: CodexFinalManifestV2,
  expected: Omit<CodexFinalizationIdentity, "rootDir" | "namespace"> & Partial<Pick<CodexFinalizationIdentity, "rootDir" | "namespace">>,
) {
  if (manifest.leaseId !== expected.leaseId || manifest.fencingToken !== expected.fencingToken) {
    throw new CodexJobFinalizationError("FINALIZATION_STALE_FENCE", "Finalization manifest belongs to a stale worker lease");
  }
  const expectedSegments = normalizeSegmentIndexes(expected.segmentIndexes);
  const actualSegments = normalizeSegmentIndexes(manifest.segmentIndexes);
  const identityMismatch = manifest.jobId !== expected.jobId
    || manifest.taskClass !== expected.taskClass
    || manifest.sourceHash !== expected.sourceHash
    || (manifest.contractHash || "") !== (expected.contractHash || "")
    || manifest.resultHash !== expected.resultHash
    || JSON.stringify(actualSegments) !== JSON.stringify(expectedSegments);
  if (identityMismatch) {
    throw new CodexJobFinalizationError("FINALIZATION_IDENTITY_MISMATCH", "Finalization manifest identity does not match the claimed job");
  }
}

export function buildFinalizedResultRef(jobId: string, resultHash: string): CodexFinalizedResultRef {
  const relativePath = ["results", jobId, resultHash].join("/");
  return {
    protocolVersion: CODEX_FINALIZATION_PROTOCOL_VERSION,
    resultHash,
    relativePath,
    manifestRelativePath: `${relativePath}/${CODEX_FINAL_MANIFEST_FILE}`,
  };
}

function assertFinalizationDirectory(
  input: Pick<CodexFinalizationIdentity, "rootDir" | "namespace" | "jobId">,
  target: string,
  directoryName: "staging" | "results",
) {
  const queueRoot = queueRootPath(input.rootDir, input.namespace);
  const expectedRoot = path.join(queueRoot, directoryName);
  const resolved = assertPathInside(expectedRoot, target);
  const relative = path.relative(expectedRoot, resolved).split(path.sep);
  if (relative[0] !== input.jobId) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", `Finalization ${directoryName} directory does not belong to this job`);
  }
  return resolved;
}

function queueRootPath(rootDir: string, namespace: string) {
  const root = path.resolve(rootDir);
  const queueRoot = path.resolve(root, namespace);
  return assertPathInside(root, queueRoot);
}

function assertPathInside(rootDir: string, target: string) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization path escapes its configured root");
  }
  return resolved;
}

function normalizeRelativeOutputPath(value: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Final output path is empty");
  }
  const normalized = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Final output path must be relative");
  }
  const clean = path.posix.normalize(normalized);
  if (clean === "." || clean === ".." || clean.startsWith("../") || clean.split("/").includes("..")) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Final output path escapes staging");
  }
  return clean;
}

function normalizeSegmentIndexes(value: number[]) {
  if (!Array.isArray(value) || !value.length || value.some((index) => !Number.isInteger(index) || index <= 0)) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization segment indexes are invalid");
  }
  const indexes = [...new Set(value)].sort((left, right) => left - right);
  if (indexes.length !== value.length) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", "Finalization segment indexes contain duplicates");
  }
  return indexes;
}

async function snapshotFinalizationFiles(directory: string, relativePaths: string[]) {
  return Promise.all(relativePaths.map(async (relativePath) => {
    const target = assertPathInside(directory, path.join(directory, ...relativePath.split("/")));
    let bytes: Buffer;
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size <= 0) throw new Error("not a non-empty file");
      bytes = await readFile(target);
    } catch (error) {
      throw new CodexJobFinalizationError(
        "FINALIZATION_OUTPUT_MISSING",
        `Finalization output is missing or empty: ${relativePath}`,
        { cause: error },
      );
    }
    return { relativePath, byteLength: bytes.byteLength, sha256: sha256(bytes) };
  }));
}

function assertSafePathComponent(value: string, field: string) {
  if (typeof value !== "string" || !value || value !== path.basename(value) || value === "." || value === "..") {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", `Finalization ${field} is invalid`);
  }
}

function assertPositiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CodexJobFinalizationError("FINALIZATION_SCHEMA_INVALID", `Finalization ${field} must be a positive integer`);
  }
}

async function readStrictUtf8(target: string) {
  const bytes = await readFile(target);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new CodexJobFinalizationError("FINALIZATION_ENCODING_INVALID", "Finalization JSON must be UTF-8 without BOM");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\ufffd")) throw new Error("replacement character");
    return text;
  } catch (error) {
    throw new CodexJobFinalizationError("FINALIZATION_ENCODING_INVALID", "Finalization JSON is not valid UTF-8", { cause: error });
  }
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortCanonicalValue(nested)]),
  );
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
