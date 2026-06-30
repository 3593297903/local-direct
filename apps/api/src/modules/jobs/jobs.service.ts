import { BadRequestException, Injectable } from "@nestjs/common";
import { JobStatus, JobType, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

type RecordAnalyzeJobInput = {
  status?: JobStatus;
  projectId?: string;
  input?: Prisma.InputJsonValue;
  output?: Prisma.InputJsonValue;
  error?: string;
};

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  async recordAnalyzeJob(userId: string, input: RecordAnalyzeJobInput) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const status = input.status === "FAILED" ? JobStatus.FAILED : JobStatus.COMPLETED;
    const job = await this.prisma.job.create({
      data: {
        userId,
        projectId: input.projectId,
        type: JobType.ANALYZE_SCRIPT,
        status,
        input: input.input || {},
        output: input.output,
        error: input.error,
        attempts: 1,
        completedAt: new Date(),
      },
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
    });

    return {
      ...job,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    };
  }
}
