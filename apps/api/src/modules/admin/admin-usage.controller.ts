import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ok } from "../../common/api-response";
import { AdminGuard } from "../auth/admin.guard";
import { ListAdminUsageEventsQueryDto } from "./admin-usage.dto";
import { AdminUsageService } from "./admin-usage.service";

@Controller("admin/usage")
@UseGuards(AdminGuard)
export class AdminUsageController {
  constructor(private readonly adminUsage: AdminUsageService) {}

  @Get("summary")
  async summary() {
    return ok(await this.adminUsage.getSummary());
  }

  @Get("events")
  async events(@Query() query: ListAdminUsageEventsQueryDto) {
    return ok(await this.adminUsage.listEvents(query));
  }
}
