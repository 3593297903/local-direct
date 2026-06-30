import { proxyNestAuthGet } from "@/lib/nest-auth-proxy";

export async function GET() {
  return proxyNestAuthGet("captcha");
}
