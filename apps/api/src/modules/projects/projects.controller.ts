import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  BuildProjectContextDto,
  CreateProjectDto,
  SaveProjectVisualEntitiesDto,
  SaveStoryboardImageDto,
  SaveShotVisualReferencesDto,
  SaveVisualAssetsDto,
  UpdateCharacterProfileDto,
  UpdateMemoryItemDto,
  UpdateProjectMemoryDto,
  UpdateStoryLoopDto,
} from "./projects.dto";
import { ProjectsService } from "./projects.service";

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  async listProjects(@Req() request: { user: { id: string } }) {
    const projects = await this.projectsService.listProjects(request.user.id);
    return ok({ projects });
  }

  @Get(":projectId")
  async getProject(@Req() request: { user: { id: string } }, @Param("projectId") projectId: string) {
    const project = await this.projectsService.getProject(request.user.id, projectId);
    return ok({ project });
  }

  @Delete(":projectId")
  async deleteProject(@Req() request: { user: { id: string } }, @Param("projectId") projectId: string) {
    const result = await this.projectsService.deleteProject(request.user.id, projectId);
    return ok(result);
  }

  @Delete(":projectId/versions/:versionId")
  async deleteProjectVersion(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
  ) {
    const result = await this.projectsService.deleteProjectVersion(request.user.id, projectId, versionId);
    return ok(result);
  }

  @Post(":projectId/context")
  async buildProjectContext(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Body() body: BuildProjectContextDto,
  ) {
    const result = await this.projectsService.buildGenerationContext(request.user.id, projectId, body.currentScript);
    return ok(result);
  }

  @Post()
  async createProject(
    @Req() request: { user: { id: string }; headers?: Record<string, string | string[] | undefined> },
    @Body() body: CreateProjectDto,
  ) {
    const incomingRequestId = request.headers?.["x-request-id"];
    const requestId = (Array.isArray(incomingRequestId) ? incomingRequestId[0] : incomingRequestId) || randomUUID();
    const result = await this.projectsService.createProject(request.user.id, body, String(requestId));
    return ok(result);
  }

  @Patch(":projectId/memory")
  async updateProjectMemory(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Body() body: UpdateProjectMemoryDto,
  ) {
    const result = await this.projectsService.updateProjectMemory(request.user.id, projectId, body);
    return ok(result);
  }

  @Patch(":projectId/characters/:characterId")
  async updateCharacterProfile(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Param("characterId") characterId: string,
    @Body() body: UpdateCharacterProfileDto,
  ) {
    const result = await this.projectsService.updateCharacterProfile(request.user.id, projectId, characterId, body);
    return ok(result);
  }

  @Patch(":projectId/story-loops/:loopId")
  async updateStoryLoop(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Param("loopId") loopId: string,
    @Body() body: UpdateStoryLoopDto,
  ) {
    const result = await this.projectsService.updateStoryLoop(request.user.id, projectId, loopId, body);
    return ok(result);
  }

  @Patch(":projectId/memories/:memoryId")
  async updateMemoryItem(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Param("memoryId") memoryId: string,
    @Body() body: UpdateMemoryItemDto,
  ) {
    const result = await this.projectsService.updateMemoryItem(request.user.id, projectId, memoryId, body);
    return ok(result);
  }

  @Post(":projectId/versions/:versionId/storyboard-image")
  async saveStoryboardImage(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: SaveStoryboardImageDto,
  ) {
    const result = await this.projectsService.saveStoryboardImage(request.user.id, projectId, versionId, body);
    return ok(result);
  }

  @Post(":projectId/versions/:versionId/visual-assets")
  async saveVisualAssets(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: SaveVisualAssetsDto,
  ) {
    const result = await this.projectsService.saveVisualAssets(request.user.id, projectId, versionId, body);
    return ok(result);
  }

  @Post(":projectId/visual-entities")
  async saveProjectVisualEntities(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Body() body: SaveProjectVisualEntitiesDto,
  ) {
    const result = await this.projectsService.saveProjectVisualEntities(request.user.id, projectId, body);
    return ok(result);
  }

  @Post(":projectId/versions/:versionId/visual-references")
  async saveShotVisualReferences(
    @Req() request: { user: { id: string } },
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: SaveShotVisualReferencesDto,
  ) {
    const result = await this.projectsService.saveShotVisualReferences(request.user.id, projectId, versionId, body);
    return ok(result);
  }
}
