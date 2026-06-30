import { timingSafeEqual } from "node:crypto";
import { ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard";

function getInternalAdminToken() {
  return (
    process.env.ADMIN_INTERNAL_TOKEN ||
    process.env.ADMIN_SESSION_SECRET ||
    process.env.ADMIN_LIBRARY_TOKEN ||
    ""
  ).trim();
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function isInternalAdminRequest(request: { headers?: Record<string, string | string[] | undefined>; user?: unknown }) {
  const expected = getInternalAdminToken();
  const received = readHeaderValue(request.headers?.["x-internal-admin-token"]).trim();
  return Boolean(expected && received && safeEqual(received, expected));
}

/**
 * Extends JwtAuthGuard: first verifies the Bearer JWT (which populates
 * request.user with { id, role, plan }), then requires role === "ADMIN".
 * Local .env admin sessions reach Nest only through the Next.js proxy, which
 * forwards a server-side x-internal-admin-token instead of exposing a JWT.
 * Use on every /api/admin/* endpoint that manages platform data.
 */
@Injectable()
export class AdminGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (isInternalAdminRequest(request)) {
      request.user = { id: "local-admin", role: "ADMIN", plan: "INTERNAL" };
      return true;
    }

    await super.canActivate(context);
    if (request.user?.role !== "ADMIN") {
      throw new ForbiddenException("Administrator access required");
    }
    return true;
  }
}
