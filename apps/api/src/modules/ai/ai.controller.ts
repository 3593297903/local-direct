import { Controller, Get } from "@nestjs/common";
import { ok } from "../../common/api-response";

@Controller("ai")
export class AiController {
  @Get("status")
  getStatus() {
    return ok({
      providers: ["deepseek", "openai", "gemini", "mock"],
      note: "AI module skeleton. Move /api/analyze here after job queue is ready.",
    });
  }
}
