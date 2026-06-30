import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { AdminGuard } from "../auth/admin.guard";
import { AuthService } from "../auth/auth.service";

@Controller("admin")
export class AdminController {
  constructor(private readonly authService: AuthService) {}

  @Get("status")
  getStatus() {
    return ok({
      enabled: true,
      note: "Admin module skeleton. Move material management and user/order admin here later.",
    });
  }

  @UseGuards(AdminGuard)
  @Get("me")
  async getCurrentAdmin(@Req() request: { user: { id: string } }) {
    return ok({ user: await this.authService.getCurrentUser(request.user.id) });
  }
}
