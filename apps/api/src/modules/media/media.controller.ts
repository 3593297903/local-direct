import { Controller, Get } from "@nestjs/common";
import { ok } from "../../common/api-response";

@Controller("media")
export class MediaController {
  @Get("status")
  getStatus() {
    return ok({
      storage: "local-placeholder",
      note: "Media module skeleton. Migrate public/previews to OSS/COS here later.",
    });
  }
}
