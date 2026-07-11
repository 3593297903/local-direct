import { NextResponse } from "next/server";

const HTTP_STATUS_BY_JOB_ERROR: Record<string, number> = {
  JOB_NOT_FOUND: 404,
  JOB_LEASE_LOST: 409,
  JOB_STORAGE_BUSY: 503,
};

export function fileJobRouteError(error: unknown, fallbackMessage: string) {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const errorCode = typeof candidate?.code === "string" ? candidate.code : undefined;
  const message = typeof candidate?.message === "string" && candidate.message.trim()
    ? candidate.message
    : fallbackMessage;
  return NextResponse.json(
    {
      ok: false,
      ...(errorCode ? { errorCode } : {}),
      error: message,
    },
    { status: errorCode ? HTTP_STATUS_BY_JOB_ERROR[errorCode] || 400 : 400 },
  );
}
