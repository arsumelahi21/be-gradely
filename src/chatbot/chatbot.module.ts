import { Module } from '@nestjs/common';
import { ChatStore } from './chat-store';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { CHATBOT_PROVIDER } from './providers/chatbot-provider.interface';
import { DemoChatbotProvider } from './providers/demo-chatbot.provider';

/**
 * DEMO chatbot. Self-contained: no Prisma, no new env vars, no external calls.
 *
 * **To plug in a real model later**, implement `ChatbotProvider` and change the
 * one `useClass` below. Nothing else — service, controller or frontend — moves.
 */
@Module({
  controllers: [ChatbotController],
  providers: [
    ChatbotService,
    ChatStore,
    { provide: CHATBOT_PROVIDER, useClass: DemoChatbotProvider },
  ],
})
export class ChatbotModule {}
