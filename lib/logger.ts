import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

const sensitiveKeyPattern = /(?:password|token|secret|api[_-]?key|authorization|cookie)/i;
const maxStringLength = 700;

function redactString(value: string) {
  if (value.length <= maxStringLength) return value;
  return `${value.slice(0, maxStringLength)}...[truncated:${value.length - maxStringLength}]`;
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) return sanitizeLogValue(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack?.split("\n").slice(0, 6).join("\n"),
  };
}

export function sanitizeLogValue(value: unknown, key = ""): unknown {
  if (sensitiveKeyPattern.test(key)) return "[redacted]";
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeLogValue(entryValue, entryKey),
      ]),
    );
  }
  return String(value);
}

function shouldLog(level: LogLevel) {
  const current = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");
  const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  return rank[level] >= (rank[current as LogLevel] ?? rank.debug);
}

function writeLog(level: LogLevel, event: string, context: LogContext = {}) {
  if (!shouldLog(level)) return;
  const sanitizedContext = sanitizeLogValue(context) as LogContext;
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    ...sanitizedContext,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export const logger = {
  debug: (event: string, context?: LogContext) => writeLog("debug", event, context),
  info: (event: string, context?: LogContext) => writeLog("info", event, context),
  warn: (event: string, context?: LogContext) => writeLog("warn", event, context),
  error: (event: string, context?: LogContext) => writeLog("error", event, context),
};

export function createRequestId(scope = "req") {
  return `${scope}_${randomUUID()}`;
}

export function durationSince(startedAt: number) {
  return Date.now() - startedAt;
}
