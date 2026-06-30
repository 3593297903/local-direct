import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminModule } from "./modules/admin/admin.module";
import { AiModule } from "./modules/ai/ai.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { LibraryModule } from "./modules/library/library.module";
import { MediaModule } from "./modules/media/media.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { UsageModule } from "./modules/usage/usage.module";
import { UsersModule } from "./modules/users/users.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.api.local", ".env.local", ".env"],
    }),
    PrismaModule,
    QueueModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    LibraryModule,
    AiModule,
    JobsModule,
    MediaModule,
    UsageModule,
    AdminModule,
  ],
})
export class AppModule {}
