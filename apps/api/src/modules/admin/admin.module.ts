import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { AdminController } from "./admin.controller";
import { AdminLogsController } from "./admin-logs.controller";
import { AdminLogsService } from "./admin-logs.service";
import { AdminProjectsController } from "./admin-projects.controller";
import { AdminProjectsService } from "./admin-projects.service";
import { AdminUsageController } from "./admin-usage.controller";
import { AdminUsageService } from "./admin-usage.service";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [
    AdminController,
    AdminUsersController,
    AdminProjectsController,
    AdminUsageController,
    AdminLogsController,
  ],
  providers: [AdminUsersService, AdminProjectsService, AdminUsageService, AdminLogsService],
})
export class AdminModule {}
