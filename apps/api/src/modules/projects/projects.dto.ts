import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from "class-validator";

export class CreateStoryboardShotDto {
  @IsNumber()
  shotNumber!: number;

  @IsOptional()
  @IsString()
  scene?: string;

  @IsOptional()
  @IsString()
  visual?: string;

  @IsOptional()
  @IsString()
  shotType?: string;

  @IsOptional()
  @IsString()
  composition?: string;

  @IsOptional()
  @IsString()
  cameraMovement?: string;

  @IsOptional()
  @IsString()
  lighting?: string;

  @IsOptional()
  @IsString()
  sound?: string;

  @IsOptional()
  @IsString()
  dialogue?: string;

  @IsOptional()
  @IsString()
  emotion?: string;

  @IsOptional()
  @IsString()
  transition?: string;

  @IsOptional()
  @IsString()
  shotPurpose?: string;

  @IsOptional()
  @IsString()
  firstFramePrompt?: string;

  @IsOptional()
  @IsString()
  videoPrompt?: string;

  @IsOptional()
  @IsString()
  lastFramePrompt?: string;

  @IsOptional()
  @IsString()
  negativePrompt?: string;
}

export class CreateProjectDto {
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  versionId?: string;

  @IsNotEmpty()
  @IsString()
  title!: string;

  @IsString()
  originalScript!: string;

  @IsOptional()
  @IsString()
  optimizedScript?: string;

  @IsOptional()
  @IsString()
  contentType?: string;

  @IsOptional()
  @IsString()
  style?: string;

  @IsOptional()
  @IsString()
  duration?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  storyboardImageUrl?: string;

  @IsOptional()
  @IsString()
  storyboardImagePrompt?: string;

  @IsOptional()
  @IsString()
  fullVideoPrompt?: string;

  @IsOptional()
  @IsObject()
  storyBible?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  contextSummary?: string;

  @IsOptional()
  @IsString()
  episodeSummary?: string;

  @IsOptional()
  @IsString()
  endingState?: string;

  @IsOptional()
  @IsString()
  characterState?: string;

  @IsOptional()
  @IsObject()
  memoryJson?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  contextSnapshot?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  narrativeMemory?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  stateVector?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  openLoops?: unknown[];

  @IsOptional()
  @IsObject()
  qualityCheck?: Record<string, unknown>;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateStoryboardShotDto)
  shots!: CreateStoryboardShotDto[];
}

export class SaveStoryboardImageDto {
  @IsString()
  storyboardImageUrl!: string;

  @IsOptional()
  @IsString()
  storyboardImagePrompt?: string;
}

export class SaveVisualAssetDto {
  @IsIn(["SHOT_STORYBOARD", "CHARACTER_TURNAROUND", "SCENE_KEYART", "PROP_SHEET"])
  type!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsUUID()
  shotId?: string;

  @IsOptional()
  @IsNumber()
  shotNumber?: number;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsString()
  variantKey?: string;

  @IsOptional()
  @IsString()
  prompt?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsIn(["PENDING", "RUNNING", "COMPLETED", "FAILED"])
  status?: string;

  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsBoolean()
  locked?: boolean;

  @IsOptional()
  @IsNumber()
  referenceWeight?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class SaveVisualAssetsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveVisualAssetDto)
  visualAssets!: SaveVisualAssetDto[];
}

export class SaveProjectVisualEntityDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsIn(["CHARACTER", "SCENE", "PROP", "STYLE"])
  type!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  canonicalPrompt?: string;

  @IsOptional()
  @IsString()
  visualLock?: string;

  @IsOptional()
  @IsString()
  negativeLock?: string;

  @IsOptional()
  @IsIn(["CANDIDATE", "APPROVED", "LOCKED", "ARCHIVED"])
  status?: string;

  @IsOptional()
  @IsUUID()
  primaryAssetId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class SaveProjectVisualEntitiesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveProjectVisualEntityDto)
  visualEntities!: SaveProjectVisualEntityDto[];
}

export class SaveShotVisualReferenceDto {
  @IsOptional()
  @IsUUID()
  shotId?: string;

  @IsOptional()
  @IsNumber()
  shotNumber?: number;

  @IsUUID()
  entityId!: string;

  @IsOptional()
  @IsIn(["SUBJECT", "BACKGROUND", "PROP", "STYLE"])
  role?: string;

  @IsOptional()
  @IsNumber()
  order?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class SaveShotVisualReferencesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveShotVisualReferenceDto)
  visualReferences!: SaveShotVisualReferenceDto[];
}

export class BuildProjectContextDto {
  @IsString()
  currentScript!: string;
}

export class UpdateProjectMemoryDto {
  @IsOptional()
  @IsObject()
  storyBible?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  contextSummary?: string;

  @IsOptional()
  @IsObject()
  stateVector?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  openLoops?: unknown[];
}

export class UpdateCharacterProfileDto {
  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  appearance?: string;

  @IsOptional()
  @IsString()
  personality?: string;

  @IsOptional()
  @IsString()
  relationshipState?: string;

  @IsOptional()
  @IsString()
  visualLock?: string;

  @IsOptional()
  @IsBoolean()
  locked?: boolean;
}

export class UpdateStoryLoopDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class UpdateMemoryItemDto {
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
