import { Injectable } from "@nestjs/common";
import type { LibraryItem } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  FrontendKnowledgeType,
  LibraryItemDto,
  toFrontendKnowledgeType,
  toPrismaKnowledgeType,
} from "./library.types";

const typeOrder: Record<FrontendKnowledgeType, number> = {
  transition: 0,
  shot: 1,
  camera_movement: 2,
  style: 3,
  storyboard_formula: 4,
};

function mapLibraryItem(item: LibraryItem): LibraryItemDto {
  return {
    id: item.id,
    type: toFrontendKnowledgeType(item.type),
    category: item.category,
    name: item.name,
    description: item.description,
    prompt: item.prompt,
    tags: item.tags,
    genre: item.genre || undefined,
    stability: item.stability,
    order: item.order || undefined,
    useCase: item.useCase || "",
    avoid: item.avoid || undefined,
    previewUrl: item.previewUrl || undefined,
    previewMimeType: item.previewMimeType || undefined,
    posterUrl: item.posterUrl || undefined,
    previewType: item.previewType || undefined,
  };
}

function sortForApi(items: LibraryItemDto[]) {
  return items.sort((left, right) => {
    const typeDiff = typeOrder[left.type] - typeOrder[right.type];
    if (typeDiff !== 0) return typeDiff;
    const leftOrder = left.order || 0;
    const rightOrder = right.order || 0;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name, "zh-Hans-CN");
  });
}

@Injectable()
export class LibraryService {
  constructor(private readonly prisma: PrismaService) {}

  async listItems(input: { q?: string; type?: FrontendKnowledgeType }) {
    const q = input.q?.trim();
    const where: Prisma.LibraryItemWhereInput = {};

    if (input.type) {
      where.type = toPrismaKnowledgeType(input.type);
    }

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
        { genre: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { prompt: { contains: q, mode: "insensitive" } },
        { tags: { has: q } },
      ];
    }

    const items = await this.prisma.libraryItem.findMany({
      where,
      orderBy: [{ type: "asc" }, { order: "asc" }, { name: "asc" }],
    });

    return sortForApi(items.map(mapLibraryItem));
  }
}
