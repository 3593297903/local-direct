import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { ok } from "../../common/api-response";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AI_GENERATION_QUEUE } from "./jobs.module";
import { JobsService } from "./jobs.service";

@Controller("jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get("status")
  getStatus() {
    return ok({
      queues: [AI_GENERATION_QUEUE],
      note: "Jobs module skeleton. Add BullMQ processors for long AI/image/video tasks.",
    });
  }

  @Post("analyze-log")
  @UseGuards(JwtAuthGuard)
  async recordAnalyzeLog(@Req() request: { user: { id: string } }, @Body() body: Record<string, unknown>) {
    return ok({
      job: await this.jobs.recordAnalyzeJob(request.user.id, {
        status: body.status === "FAILED" ? "FAILED" : "COMPLETED",
        projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        input: (body.input && typeof body.input === "object" ? body.input : {}) as Prisma.InputJsonValue,
        output:
          body.output && typeof body.output === "object"
            ? (body.output as Prisma.InputJsonValue)
            : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
      }),
    });
  }
}
