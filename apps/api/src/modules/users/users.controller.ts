import { Controller, Get } from "@nestjs/common";
import { ok } from "../../common/api-response";

@Controller("users")
export class UsersController {
  @Get("me")
  getCurrentUser() {
    return ok({
      user: null,
      note: "User profile endpoint skeleton.",
    });
  }
}
