import fsp from "node:fs/promises";
import path from "node:path";

export const CODEX_QUOTA_EXHAUSTED_CODE = "CODEX_QUOTA_EXHAUSTED";
export const CODEX_QUOTA_EXHAUSTED_MESSAGE = "Codex 额度已用完或暂时受限，请恢复额度后再继续生成。";

const DEFAULT_QUOTA_CIRCUIT_TTL_MS = 60 * 60_000;
const QUOTA_PATTERNS = [
  /CODEX_QUOTA_EXHAUSTED/i,
  /insufficient[_\s-]?quota/i,
  /quota/i,
  /usage\s+limit/i,
  /limit\s+reached/i,
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /billing/i,
  /credits?/i,
  /resource[_\s-]?exhausted/i,
  /\b429\b/,
];

export type CodexRuntimeState = {
  available: boolean;
  code?: typeof CODEX_QUOTA_EXHAUSTED_CODE;
  message?: string;
  source?: string;
  rawMessage?: string;
  detectedAt?: string;
  expiresAt?: string;
};

export class CodexQuotaExhaustedError extends Error {
  code = CODEX_QUOTA_EXHAUSTED_CODE;

  constructor(message = CODEX_QUOTA_EXHAUSTED_MESSAGE) {
    super(`${CODEX_QUOTA_EXHAUSTED_CODE}: ${message}`);
    this.name = "CodexQuotaExhaustedError";
  }
}

export function isCodexQuotaExhaustedMessage(message: unknown) {
  const text = String(message || "");
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

export function normalizeCodexQuotaErrorMessage(message: unknown) {
  const text = String(message || "").trim();
  if (!isCodexQuotaExhaustedMessage(text)) return text;
  if (text.includes(CODEX_QUOTA_EXHAUSTED_CODE) && text.includes(CODEX_QUOTA_EXHAUSTED_MESSAGE)) return text;
  return `${CODEX_QUOTA_EXHAUSTED_CODE}: ${CODEX_QUOTA_EXHAUSTED_MESSAGE}${text ? `\n原始错误：${text}` : ""}`;
}

export async function markCodexQuotaExhausted(
  source: string,
  rawMessage: unknown,
  options: { rootDir?: string; ttlMs?: number } = {},
) {
  const rootDir = options.rootDir || process.cwd();
  const now = new Date();
  const ttlMs = positiveInteger(options.ttlMs, positiveInteger(process.env.CODEX_QUOTA_CIRCUIT_TTL_MS, DEFAULT_QUOTA_CIRCUIT_TTL_MS));
  const state: CodexRuntimeState = {
    available: false,
    code: CODEX_QUOTA_EXHAUSTED_CODE,
    message: CODEX_QUOTA_EXHAUSTED_MESSAGE,
    source,
    rawMessage: String(rawMessage || ""),
    detectedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const filePath = stateFilePath(rootDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function getCodexRuntimeState(options: { rootDir?: string } = {}): Promise<CodexRuntimeState> {
  const rootDir = options.rootDir || process.cwd();
  const filePath = stateFilePath(rootDir);
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(stripJsonBom(raw)) as CodexRuntimeState;
    if (!parsed || parsed.available !== false || parsed.code !== CODEX_QUOTA_EXHAUSTED_CODE) {
      return { available: true };
    }
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
      await clearCodexRuntimeState({ rootDir }).catch(() => undefined);
      return { available: true };
    }
    return parsed;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      return { available: true };
    }
    return { available: true };
  }
}

export async function assertCodexRuntimeAvailable(options: { rootDir?: string } = {}) {
  const state = await getCodexRuntimeState(options);
  if (!state.available) {
    throw new CodexQuotaExhaustedError(state.message);
  }
}

export async function clearCodexRuntimeState(options: { rootDir?: string } = {}) {
  const rootDir = options.rootDir || process.cwd();
  await fsp.rm(stateFilePath(rootDir), { force: true });
}

function stateFilePath(rootDir: string) {
  return path.join(rootDir, ".tmp-codex-runtime", "state.json");
}

function stripJsonBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
