import { Controller, Delete, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { AdminGuard } from "../auth/admin.guard";
import { ListAdminProjectsQueryDto } from "./admin-projects.dto";
import { AdminProjectsService } from "./admin-projects.service";

@Controller("admin/projects")
@UseGuards(AdminGuard)
export class AdminProjectsController {
  constructor(private readonly adminProjects: AdminProjectsService) {}

  @Get()
  async list(@Query() query: ListAdminProjectsQueryDto) {
    return ok(await this.adminProjects.listProjects(query));
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    return ok({ project: await this.adminProjects.getProject(id) });
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    return ok(await this.adminProjects.deleteProject(id));
  }
}
