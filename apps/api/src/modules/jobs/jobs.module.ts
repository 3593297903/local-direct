import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";

export const AI_GENERATION_QUEUE = "ai-generation";

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: AI_GENERATION_QUEUE }), PrismaModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
