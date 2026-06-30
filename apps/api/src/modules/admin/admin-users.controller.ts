import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ok } from "../../common/api-response";
import { AdminGuard } from "../auth/admin.guard";
import { CreateUserDto, ListUsersQueryDto, UpdateUserDto } from "./admin-users.dto";
import { AdminUsersService } from "./admin-users.service";

@Controller("admin/users")
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  async list(@Query() query: ListUsersQueryDto) {
    return ok(await this.adminUsers.listUsers(query));
  }

  @Post()
  async create(@Body() body: CreateUserDto) {
    return ok({ user: await this.adminUsers.createUser(body) });
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    return ok({ user: await this.adminUsers.getUser(id) });
  }

  @Patch(":id")
  async update(
    @Req() request: { user: { id: string } },
    @Param("id") id: string,
    @Body() body: UpdateUserDto,
  ) {
    return ok({ user: await this.adminUsers.updateUser(request.user.id, id, body) });
  }

  @Delete(":id")
  async remove(@Req() request: { user: { id: string } }, @Param("id") id: string) {
    return ok(await this.adminUsers.deleteUser(request.user.id, id));
  }
}
