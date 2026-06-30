import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ListAdminUsageEventsQueryDto } from "./admin-usage.dto";

function parsePage(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

@Injectable()
export class AdminUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const today = startOfToday();
    const [
      userCount,
      activeUserCount,
      projectCount,
      analyzeToday,
      analyzeTotal,
      completedJobsToday,
      failedJobsToday,
      creditAggregate,
      dailyLimitAggregate,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: "ACTIVE" } }),
      this.prisma.project.count(),
      this.prisma.usageEvent.count({
        where: { eventType: "ANALYZE_SCRIPT", createdAt: { gte: today } },
      }),
      this.prisma.usageEvent.count({ where: { eventType: "ANALYZE_SCRIPT" } }),
      this.prisma.job.count({
        where: { type: "ANALYZE_SCRIPT", status: "COMPLETED", createdAt: { gte: today } },
      }),
      this.prisma.job.count({
        where: { type: "ANALYZE_SCRIPT", status: "FAILED", createdAt: { gte: today } },
      }),
      this.prisma.user.aggregate({ _sum: { credits: true } }),
      this.prisma.user.aggregate({ _sum: { dailyLimit: true } }),
    ]);

    return {
      userCount,
      activeUserCount,
      projectCount,
      analyzeToday,
      analyzeTotal,
      completedJobsToday,
      failedJobsToday,
      totalCredits: creditAggregate._sum.credits ?? 0,
      totalDailyLimit: dailyLimitAggregate._sum.dailyLimit ?? 0,
    };
  }

  async listEvents(query: ListAdminUsageEventsQueryDto) {
    const page = parsePage(query.page, 1);
    const pageSize = Math.min(100, parsePage(query.pageSize, 30));
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    const q = query.q?.trim();

    const where: Prisma.UsageEventWhereInput = {};
    if (query.userId) where.userId = query.userId;
    if (query.eventType) where.eventType = query.eventType;
    if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q) {
      where.OR = [
        { provider: { contains: q, mode: "insensitive" } },
        { model: { contains: q, mode: "insensitive" } },
        { user: { email: { contains: q, mode: "insensitive" } } },
        { user: { phone: { contains: q, mode: "insensitive" } } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.usageEvent.count({ where }),
      this.prisma.usageEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          eventType: true,
          provider: true,
          model: true,
          inputChars: true,
          outputChars: true,
          costEstimate: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              plan: true,
              status: true,
            },
          },
        },
      }),
    ]);

    return {
      events: rows.map((event) => ({
        ...event,
        costEstimate: event.costEstimate.toString(),
        createdAt: event.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}
