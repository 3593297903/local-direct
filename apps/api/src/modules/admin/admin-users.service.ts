import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { hashPassword } from "../auth/password";
import { CreateUserDto, ListUsersQueryDto, UpdateUserDto } from "./admin-users.dto";

const adminUserSelect = {
  id: true,
  email: true,
  phone: true,
  role: true,
  plan: true,
  status: true,
  credits: true,
  dailyLimit: true,
  lastLoginAt: true,
  loginCount: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof adminUserSelect }> & {
  _count?: { projects: number };
};

function mapAdminUser(user: AdminUserRow) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    plan: user.plan,
    status: user.status,
    credits: user.credits,
    dailyLimit: user.dailyLimit,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    loginCount: user.loginCount,
    note: user.note,
    projectCount: user._count?.projects ?? 0,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function pickUpdatableFields(input: UpdateUserDto) {
  const data: Prisma.UserUpdateInput = {};
  if (input.role !== undefined) data.role = input.role;
  if (input.plan !== undefined) data.plan = input.plan;
  if (input.status !== undefined) data.status = input.status;
  if (input.credits !== undefined) data.credits = input.credits;
  if (input.dailyLimit !== undefined) data.dailyLimit = input.dailyLimit;
  if (input.note !== undefined) data.note = input.note;
  return data;
}

@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async createUser(input: CreateUserDto) {
    const normalizedEmail = input.email?.trim().toLowerCase() || null;
    const normalizedPhone = input.phone?.replace(/\s+/g, "").trim() || null;

    if (!normalizedEmail && !normalizedPhone) {
      throw new BadRequestException("Email or phone is required");
    }

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
          ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
        ],
      },
      select: { id: true },
    });
    if (existing) throw new BadRequestException("User email or phone already exists");

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordHash: await hashPassword(input.password),
        role: "USER",
        plan: "FREE",
        status: "ACTIVE",
        credits: 0,
        dailyLimit: 3,
      },
      select: { ...adminUserSelect, _count: { select: { projects: true } } },
    });
    return mapAdminUser(user);
  }

  async listUsers(query: ListUsersQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));

    const where: Prisma.UserWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.plan) where.plan = query.plan;
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { ...adminUserSelect, _count: { select: { projects: true } } },
      }),
    ]);

    return {
      users: rows.map(mapAdminUser),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { ...adminUserSelect, _count: { select: { projects: true } } },
    });
    if (!user) throw new NotFoundException("User not found");
    return mapAdminUser(user);
  }

  async updateUser(actorId: string, id: string, input: UpdateUserDto) {
    if (id === actorId && (input.status === "DISABLED" || input.role === "USER")) {
      throw new ForbiddenException("Cannot disable or demote your own account");
    }

    const data = pickUpdatableFields(input);
    if (Object.keys(data).length === 0) {
      throw new BadRequestException("No updatable fields provided");
    }

    const existing = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException("User not found");

    const user = await this.prisma.user.update({
      where: { id },
      data,
      select: { ...adminUserSelect, _count: { select: { projects: true } } },
    });
    return mapAdminUser(user);
  }

  async deleteUser(actorId: string, id: string) {
    if (id === actorId) throw new ForbiddenException("Cannot delete your own account");

    const existing = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException("User not found");

    await this.prisma.user.delete({ where: { id } });
    return { deleted: true, id };
  }
}
