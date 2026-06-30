import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ListAdminLogsQueryDto } from "./admin-logs.dto";

function parsePage(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

@Injectable()
export class AdminLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async listLogs(query: ListAdminLogsQueryDto) {
    const page = parsePage(query.page, 1);
    const pageSize = Math.min(100, parsePage(query.pageSize, 30));
    const q = query.q?.trim();

    const where: Prisma.JobWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.userId) where.userId = query.userId;
    if (q) {
      where.OR = [
        { error: { contains: q, mode: "insensitive" } },
        { user: { email: { contains: q, mode: "insensitive" } } },
        { user: { phone: { contains: q, mode: "insensitive" } } },
        { project: { title: { contains: q, mode: "insensitive" } } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.job.count({ where }),
      this.prisma.job.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          input: true,
          output: true,
          error: true,
          attempts: true,
          createdAt: true,
          completedAt: true,
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              plan: true,
            },
          },
          project: {
            select: {
              id: true,
              title: true,
            },
          },
          logs: {
            orderBy: { createdAt: "desc" },
            take: 5,
            select: {
              id: true,
              level: true,
              message: true,
              meta: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    return {
      jobs: rows.map((job) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt ? job.completedAt.toISOString() : null,
        logs: job.logs.map((log) => ({
          ...log,
          createdAt: log.createdAt.toISOString(),
        })),
      })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}
