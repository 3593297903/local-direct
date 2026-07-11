export const CODEX_QUOTA_EXHAUSTED_CODE = "CODEX_QUOTA_EXHAUSTED";
export const CODEX_QUOTA_EXHAUSTED_MESSAGE = "Codex 额度已用完或暂时受限，请恢复额度后再继续生成。";
export const CODEX_CLI_VERSION_UNSUPPORTED_CODE = "CODEX_CLI_VERSION_UNSUPPORTED";
export const CODEX_CLI_VERSION_UNSUPPORTED_MESSAGE = "Codex CLI 版本过旧，无法使用当前模型。请升级 Codex CLI 后重新生成。";

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

const CLI_VERSION_UNSUPPORTED_PATTERNS = [
  /CODEX_CLI_VERSION_UNSUPPORTED/i,
  /requires?\s+(?:a\s+)?newer\s+version\s+of\s+Codex/i,
  /please\s+upgrade\s+to\s+the\s+latest\s+(?:app\s+or\s+)?CLI/i,
];

export function isCodexQuotaErrorText(value) {
  const text = String(value || "");
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

export function isCodexCliVersionUnsupportedErrorText(value) {
  const text = String(value || "");
  return CLI_VERSION_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildCodexFailureMessage(baseMessage, capturedOutput = "") {
  const rawCapturedOutput = String(capturedOutput || "");
  const rawOutputExcerpt = compactOutput(rawCapturedOutput);
  const joinedForDetection = [baseMessage, rawCapturedOutput].filter(Boolean).join("\nCodex output: ");
  const outputExcerpt = summarizeCodexOutputExcerpt(rawOutputExcerpt);
  const joined = [baseMessage, outputExcerpt].filter(Boolean).join("\nCodex output: ");
  if (isCodexCliVersionUnsupportedErrorText(joinedForDetection)) {
    return `${CODEX_CLI_VERSION_UNSUPPORTED_CODE}: ${CODEX_CLI_VERSION_UNSUPPORTED_MESSAGE}`;
  }
  if (!isCodexQuotaErrorText(joinedForDetection)) return joined || String(baseMessage || "codex exec failed");
  return [
    `${CODEX_QUOTA_EXHAUSTED_CODE}: ${CODEX_QUOTA_EXHAUSTED_MESSAGE}`,
    outputExcerpt ? `Codex output: ${outputExcerpt}` : "",
  ].filter(Boolean).join("\n");
}

export function appendCapturedOutput(current, chunk, limit = 12_000) {
  const next = `${current || ""}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "")}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function compactOutput(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= 1200) return text;
  return `${text.slice(0, 1200)}...`;
}

function summarizeCodexOutputExcerpt(value) {
  const text = String(value || "");
  if (!looksLikeEchoedTaskPrompt(text)) return text;
  return "Codex returned task prompt or SegmentContract text instead of a valid result. Check the local worker log for the full output.";
}

function looksLikeEchoedTaskPrompt(text) {
  return /(SEGMENT CONTRACT|LOCKED SEGMENT PLAN|Segment index|forbiddenFutureEvents|requiredShotBeats|renderInputScript|Video prompt generation instructions)/i.test(text);
}
