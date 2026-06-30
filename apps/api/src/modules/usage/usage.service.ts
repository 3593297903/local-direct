import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

type ConsumeAnalyzeUsageInput = {
  provider?: string;
  model?: string;
  inputChars?: number;
  outputChars?: number;
};

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(userId: string) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const today = startOfToday();
    const [user, usedToday] = await this.prisma.$transaction([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, credits: true, dailyLimit: true, plan: true, status: true },
      }),
      this.prisma.usageEvent.count({
        where: { userId, eventType: "ANALYZE_SCRIPT", createdAt: { gte: today } },
      }),
    ]);

    if (!user) throw new BadRequestException("User not found");

    return {
      credits: user.credits,
      dailyLimit: user.dailyLimit,
      usedToday,
      remainingToday: Math.max(0, user.dailyLimit - usedToday),
      plan: user.plan,
      status: user.status,
    };
  }

  async consumeAnalyzeUsage(userId: string, input: ConsumeAnalyzeUsageInput) {
    if (!userId) throw new BadRequestException("Authenticated user id is required");

    const today = startOfToday();
    return this.prisma.$transaction(async (prisma) => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, credits: true, dailyLimit: true, status: true },
      });
      if (!user) throw new BadRequestException("User not found");
      if (user.status === "DISABLED") throw new ForbiddenException("User account is disabled");

      const usedToday = await prisma.usageEvent.count({
        where: { userId, eventType: "ANALYZE_SCRIPT", createdAt: { gte: today } },
      });
      const overDailyLimit = usedToday >= user.dailyLimit;
      if (overDailyLimit && user.credits <= 0) {
        throw new ForbiddenException("Daily generation limit reached");
      }

      const updatedUser = overDailyLimit
        ? await prisma.user.update({
            where: { id: userId },
            data: { credits: { decrement: 1 } },
            select: { credits: true, dailyLimit: true },
          })
        : user;

      const event = await prisma.usageEvent.create({
        data: {
          userId,
          eventType: "ANALYZE_SCRIPT",
          provider: input.provider,
          model: input.model,
          inputChars: Math.max(0, Number(input.inputChars) || 0),
          outputChars: Math.max(0, Number(input.outputChars) || 0),
        },
        select: { id: true, createdAt: true },
      });

      return {
        eventId: event.id,
        usedToday: usedToday + 1,
        dailyLimit: updatedUser.dailyLimit,
        creditsRemaining: updatedUser.credits,
        usedCredit: overDailyLimit,
        createdAt: event.createdAt.toISOString(),
      };
    });
  }
}
