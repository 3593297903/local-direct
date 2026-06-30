import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { AdminGuard } from "../auth/admin.guard";
import { ListAdminLogsQueryDto } from "./admin-logs.dto";
import { AdminLogsService } from "./admin-logs.service";

@Controller("admin/logs")
@UseGuards(AdminGuard)
export class AdminLogsController {
  constructor(private readonly adminLogs: AdminLogsService) {}

  @Get()
  async list(@Query() query: ListAdminLogsQueryDto) {
    return ok(await this.adminLogs.listLogs(query));
  }
}
