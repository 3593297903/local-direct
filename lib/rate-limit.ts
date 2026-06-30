type RateLimitInput = {
  key: string;
  limit: number;
  windowMs: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitBucket>();

export function checkRateLimit(input: RateLimitInput) {
  const now = Date.now();
  const bucket = buckets.get(input.key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(input.key, { count: 1, resetAt: now + input.windowMs });
    return { allowed: true, remaining: Math.max(input.limit - 1, 0), resetAt: now + input.windowMs };
  }

  if (bucket.count >= input.limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { allowed: true, remaining: Math.max(input.limit - bucket.count, 0), resetAt: bucket.resetAt };
}

export function resetRateLimit() {
  buckets.clear();
}

export function rateLimitKey(request: Request, scope: string) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip") || "local";
  return `${scope}:${forwardedFor || realIp}`;
}
