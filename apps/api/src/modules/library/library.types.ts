import type { KnowledgeType } from "@prisma/client";

export type FrontendKnowledgeType = "transition" | "shot" | "camera_movement" | "style" | "storyboard_formula";

export type LibraryItemDto = {
  id: string;
  type: FrontendKnowledgeType;
  category: string;
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  genre?: string;
  stability: number;
  order?: number;
  useCase: string;
  avoid?: string;
  previewUrl?: string;
  previewMimeType?: string;
  posterUrl?: string;
  previewType?: string;
};

export function toPrismaKnowledgeType(type: FrontendKnowledgeType): KnowledgeType {
  const mapping: Record<FrontendKnowledgeType, KnowledgeType> = {
    transition: "TRANSITION",
    shot: "SHOT",
    camera_movement: "CAMERA_MOVEMENT",
    style: "STYLE",
    storyboard_formula: "STORYBOARD_FORMULA",
  };
  return mapping[type];
}

export function toFrontendKnowledgeType(type: KnowledgeType): FrontendKnowledgeType {
  const mapping: Record<KnowledgeType, FrontendKnowledgeType> = {
    TRANSITION: "transition",
    SHOT: "shot",
    CAMERA_MOVEMENT: "camera_movement",
    STYLE: "style",
    STORYBOARD_FORMULA: "storyboard_formula",
  };
  return mapping[type];
}
