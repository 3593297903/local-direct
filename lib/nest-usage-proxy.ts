import { NextRequest } from "next/server";
import { NEST_AUTH_TOKEN_COOKIE } from "@/lib/nest-auth-proxy";

type NestResponse = Record<string, unknown> & {
  ok?: boolean;
  data?: unknown;
  error?: string;
  message?: string | string[];
};

type AnalyzeUsageInput = {
  provider?: string;
  model?: string;
  inputChars?: number;
  outputChars?: number;
};

type AnalyzeJobInput = {
  status: "COMPLETED" | "FAILED";
  projectId?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
};

function getNestApiBaseUrl() {
  return (process.env.NEST_API_BASE_URL || "http://localhost:4000/api").replace(/\/+$/, "");
}

function getBearerToken(request: NextRequest) {
  return request.cookies.get(NEST_AUTH_TOKEN_COOKIE)?.value;
}

function formatUpstreamError(payload: NestResponse | null, fallback: string) {
  const message = payload ? payload.error || payload.message || fallback : fallback;
  return Array.isArray(message) ? message.join("; ") : message;
}

async function readJson(response: Response): Promise<NestResponse | null> {
  try {
    return (await response.json()) as NestResponse;
  } catch {
    return null;
  }
}

async function postToNest(request: NextRequest, path: string, body: Record<string, unknown>) {
  const token = getBearerToken(request);
  if (!token) return { ok: true, skipped: true };

  let upstream: Response;
  try {
    upstream = await fetch(`${getNestApiBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      status: 502,
      error: "Usage service is unavailable. Start the Nest API with npm run api:dev.",
    };
  }

  const payload = await readJson(upstream);
  if (!upstream.ok || !payload || !payload.ok) {
    return {
      ok: false,
      status: upstream.status || 502,
      error: formatUpstreamError(payload, "Usage request failed"),
    };
  }

  return { ok: true, data: payload.data ?? null };
}

export function consumeAnalyzeUsageFromNest(request: NextRequest, input: AnalyzeUsageInput) {
  return postToNest(request, "/usage/analyze", {
    provider: input.provider || "",
    model: input.model || "",
    inputChars: input.inputChars || 0,
    outputChars: input.outputChars || 0,
  });
}

export function recordAnalyzeJobToNest(request: NextRequest, input: AnalyzeJobInput) {
  return postToNest(request, "/jobs/analyze-log", {
    status: input.status,
    projectId: input.projectId,
    input: input.input || {},
    output: input.output || {},
    error: input.error,
  });
}
