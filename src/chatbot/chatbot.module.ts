import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { ExamsModule } from '../exams/exams.module';
import { FeesModule } from '../fees/fees.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatbotAppDataService } from './app-data.service';
import { ChatRepository } from './chat-repository';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { CHATBOT_PROVIDER } from './providers/chatbot-provider.interface';
import { AppDataChatbotProvider } from './providers/app-data-chatbot.provider';
import { DemoChatbotProvider } from './providers/demo-chatbot.provider';
import { LlmChatbotProvider } from './providers/llm-chatbot.provider';

/**
 * Chatbot. No Prisma of its own and no new env vars: data answers go through the
 * feature services imported below, so the chatbot inherits their tenant scoping
 * instead of restating it.
 *
 * **To plug in a real model later**, implement `ChatbotProvider` and change the
 * one `useClass` below. Nothing else — service, controller or frontend — moves.
 */
@Module({
  imports: [
    PrismaModule,
    DashboardModule,
    AttendanceModule,
    FeesModule,
    AcademicsModule,
    ExamsModule,
  ],
  controllers: [ChatbotController],
  providers: [
    ChatbotService,
    ChatRepository,
    ChatbotAppDataService,
    DemoChatbotProvider,
    AppDataChatbotProvider,
    // The model answers when a key is configured; without one the deterministic
    // engine IS the assistant, so local dev, CI and e2e need no key and spend
    // no tokens.
    {
      provide: CHATBOT_PROVIDER,
      useFactory: (
        data: ChatbotAppDataService,
        keyword: AppDataChatbotProvider,
      ) =>
        // CHATBOT_DISABLE_LLM is how the e2e suite stays deterministic and free:
        // a real key in `.env` reaches the test app through ConfigModule, so the
        // suite sets this flag rather than trying to unset the key.
        process.env.ANTHROPIC_API_KEY &&
        process.env.CHATBOT_DISABLE_LLM !== 'true'
          ? new LlmChatbotProvider(data, keyword)
          : keyword,
      inject: [ChatbotAppDataService, AppDataChatbotProvider],
    },
  ],
})
export class ChatbotModule {}
