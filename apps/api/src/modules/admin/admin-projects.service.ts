import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ListAdminProjectsQueryDto } from "./admin-projects.dto";

function parsePage(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function serializeJson(value: Prisma.JsonValue | null | undefined) {
  return value ?? null;
}

@Injectable()
export class AdminProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async listProjects(query: ListAdminProjectsQueryDto) {
    const page = parsePage(query.page, 1);
    const pageSize = Math.min(100, parsePage(query.pageSize, 20));
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    const q = query.q?.trim();

    const where: Prisma.ProjectWhereInput = {};
    if (query.userId) where.userId = query.userId;
    if (query.status) where.status = query.status;
    if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { originalScript: { contains: q, mode: "insensitive" } },
        { optimizedScript: { contains: q, mode: "insensitive" } },
        { user: { email: { contains: q, mode: "insensitive" } } },
        { user: { phone: { contains: q, mode: "insensitive" } } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          contentType: true,
          style: true,
          duration: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              role: true,
              plan: true,
              status: true,
            },
          },
          _count: {
            select: {
              versions: true,
              shots: true,
              jobs: true,
            },
          },
        },
      }),
    ]);

    return {
      projects: rows.map((project) => ({
        id: project.id,
        title: project.title,
        contentType: project.contentType,
        style: project.style,
        duration: project.duration,
        status: project.status,
        user: project.user,
        versionCount: project._count.versions,
        shotCount: project._count.shots,
        jobCount: project._count.jobs,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async getProject(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        originalScript: true,
        optimizedScript: true,
        contentType: true,
        style: true,
        duration: true,
        status: true,
        storyBible: true,
        contextSummary: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            role: true,
            plan: true,
            status: true,
          },
        },
        versions: {
          orderBy: { versionNumber: "desc" },
          select: {
            id: true,
            versionNumber: true,
            title: true,
            originalScript: true,
            optimizedScript: true,
            contentType: true,
            style: true,
            duration: true,
            status: true,
            storyboardImageUrl: true,
            storyboardImagePrompt: true,
            fullVideoPrompt: true,
            episodeSummary: true,
            endingState: true,
            characterState: true,
            memoryJson: true,
            contextSnapshot: true,
            createdAt: true,
            shots: {
              orderBy: { shotNumber: "asc" },
              select: {
                id: true,
                shotNumber: true,
                scene: true,
                visual: true,
                shotType: true,
                cameraMovement: true,
                emotion: true,
                transition: true,
                firstFramePrompt: true,
                videoPrompt: true,
                lastFramePrompt: true,
                negativePrompt: true,
              },
            },
          },
        },
        jobs: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            type: true,
            status: true,
            error: true,
            attempts: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });

    if (!project) throw new NotFoundException("Project not found");

    return {
      id: project.id,
      title: project.title,
      originalScript: project.originalScript,
      optimizedScript: project.optimizedScript,
      contentType: project.contentType,
      style: project.style,
      duration: project.duration,
      status: project.status,
      storyBible: serializeJson(project.storyBible),
      contextSummary: project.contextSummary,
      user: project.user,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      versions: project.versions.map((version) => ({
        ...version,
        memoryJson: serializeJson(version.memoryJson),
        contextSnapshot: serializeJson(version.contextSnapshot),
        createdAt: version.createdAt.toISOString(),
      })),
      jobs: project.jobs.map((job) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt ? job.completedAt.toISOString() : null,
      })),
    };
  }

  async deleteProject(id: string) {
    await this.getProject(id);
    await this.prisma.project.delete({ where: { id } });
    return { deleted: true, id };
  }
}
