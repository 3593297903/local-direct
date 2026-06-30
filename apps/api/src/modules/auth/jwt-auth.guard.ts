import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

type JwtPayload = {
  sub: string;
  role?: string;
  plan?: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.Authorization || request.headers.authorization || "";
    const [scheme, token] = String(authorization).split(" ");

    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedException("Missing Bearer token");
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = {
        id: payload.sub,
        role: payload.role,
        plan: payload.plan,
      };
      return true;
    } catch {
      throw new UnauthorizedException("Invalid Bearer token");
    }
  }
}
