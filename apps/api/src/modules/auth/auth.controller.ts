import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { AuthService } from "./auth.service";
import { LoginDto, RegisterDto, ResetPasswordDto, SendCodeDto } from "./auth.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get("status")
  getStatus() {
    return ok({
      authenticated: false,
      providers: ["phone-code-register", "email-or-phone-password"],
    });
  }

  @Get("captcha")
  getCaptcha() {
    return ok(this.authService.generateCaptcha());
  }

  @Post("send-code")
  async sendCode(@Body() body: SendCodeDto) {
    return ok(await this.authService.sendCode(body));
  }

  @Post("register")
  async register(@Body() body: RegisterDto) {
    return ok(await this.authService.register(body));
  }

  @Post("login")
  async login(@Body() body: LoginDto) {
    return ok(await this.authService.login(body));
  }

  @Post("reset-password")
  async resetPassword(@Body() body: ResetPasswordDto) {
    return ok(await this.authService.resetPassword(body));
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  async me(@Req() request: any) {
    return ok({ user: await this.authService.getCurrentUser(request.user.id) });
  }
}
