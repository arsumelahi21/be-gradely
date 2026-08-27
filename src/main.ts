import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Route SIGTERM/SIGINT through Nest's lifecycle so PrismaService.onModuleDestroy
  // runs a clean $disconnect on shutdown/redeploy (no lingering DB connections).
  app.enableShutdownHooks();

  app.setGlobalPrefix('api');

  // Baseline security headers (CSP/HSTS/X-Frame-Options/etc.) — defense in depth
  // (Phase 4.3b). This is a JSON API, so cross-origin resource use is fine.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  // Reflecting every origin while allowing credentials defeats CORS (PLAN.md
  // P0-13c). Restrict to an explicit allow-list from CORS_ORIGINS, env-configurable.
  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    // Cache the CORS preflight so cross-origin dashboards don't re-run an OPTIONS
    // round-trip per request on every navigation (browsers cap this — Chrome ~2h).
    maxAge: 86400,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT || 3002);
}
bootstrap();
