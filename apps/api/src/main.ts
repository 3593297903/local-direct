import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const port = Number(config.get("API_PORT") || 4000);
  const corsOrigin = config.get<string>("API_CORS_ORIGIN") || "http://localhost:3000";

  app.enableCors({
    origin: corsOrigin.split(",").map((item) => item.trim()),
    credentials: true,
  });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.listen(port);
  console.log(`AI Video Director API listening on http://localhost:${port}/api`);
}

void bootstrap();
