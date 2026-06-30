import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { UsageService } from "./usage.service";

@Controller("usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get("summary")
  @UseGuards(JwtAuthGuard)
  async getSummary(@Req() request: { user: { id: string } }) {
    return ok(await this.usage.getSummary(request.user.id));
  }

  @Post("analyze")
  @UseGuards(JwtAuthGuard)
  async consumeAnalyze(@Req() request: { user: { id: string } }, @Body() body: Record<string, unknown>) {
    return ok(
      await this.usage.consumeAnalyzeUsage(request.user.id, {
        provider: typeof body.provider === "string" ? body.provider : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        inputChars: Number(body.inputChars) || 0,
        outputChars: Number(body.outputChars) || 0,
      }),
    );
  }
}
