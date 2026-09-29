import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  tooManyAttempts,
  UserThrottlerGuard,
} from './auth/guards/user-throttler.guard';
import { Redis } from 'ioredis';
import { ThrottlerRedisStorage } from './common/services/throttler-redis.storage';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './common/cache.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SchoolsModule } from './schools/schools.module';
import { AcademicsModule } from './academics/academics.module';
import { TeachersModule } from './teachers/teachers.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { ExamsModule } from './exams/exams.module';
import { AttendanceModule } from './attendance/attendance.module';
import { QuizzesModule } from './quizzes/quizzes.module';
import { SettingsModule } from './settings/settings.module';
import { MessagingModule } from './messaging/messaging.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SearchModule } from './search/search.module';
import { AuditModule } from './audit/audit.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { FeesModule } from './fees/fees.module';
// DEMO module — see AI_CHATBOT_IMPLEMENTATION.md. Delete this import and the
// ChatbotModule entry below to remove the chatbot entirely.
import { ChatbotModule } from './chatbot/chatbot.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    // Global rate limiting (PLAN.md P0-13a / Phase 1 §1.5.1): 100 req/min per
    // signed-in user, or per IP when anonymous (UserThrottlerGuard); auth-sensitive
    // routes tighten this with @Throttle.
    // THROTTLE_LIMIT is how the e2e suite lifts the cap — an APP_GUARD cannot
    // be replaced with overrideGuard().
    // Counters live in Redis when one is configured, so the limit is per
    // deployment: with the default in-memory storage every process allows the
    // full quota, making the real limit N × THROTTLE_LIMIT.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60_000, // 1 minute (ms)
          limit: Number(process.env.THROTTLE_LIMIT ?? 100),
        },
      ],
      errorMessage: (_context, { timeToBlockExpire }) =>
        tooManyAttempts(timeToBlockExpire),
      ...(process.env.REDIS_URL
        ? {
            storage: new ThrottlerRedisStorage(
              new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
                connectTimeout: 1000,
                commandTimeout: 1000,
              }),
            ),
          }
        : {}),
    }),
    // Phase 3: internal event bus (notification fan-out) + cron (scheduled announcements).
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    CacheModule,
    AuthModule,
    UsersModule,
    SchoolsModule,
    AcademicsModule,
    TeachersModule,
    AssignmentsModule,
    ExamsModule,
    AttendanceModule,
    QuizzesModule,
    SettingsModule,
    MessagingModule,
    AnnouncementsModule,
    NotificationsModule,
    SearchModule,
    AuditModule,
    DashboardModule,
    FeesModule,
    ChatbotModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
})
export class AppModule {}
