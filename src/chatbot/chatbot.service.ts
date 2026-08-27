import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PaginationQueryDto,
  resolvePagination,
} from '../common/dto/pagination-query.dto';
import { Role } from '../common/types/role.type';
import { ChatStore } from './chat-store';
import type { Chat, ChatMessage, ChatSummary } from './chatbot.types';
import {
  CHATBOT_PROVIDER,
  type ChatbotProvider,
} from './providers/chatbot-provider.interface';
import { CreateChatDto } from './dto/create-chat.dto';
import { SendMessageDto } from './dto/send-message.dto';

/** The authenticated principal, as `JwtStrategy.validate()` shapes it. */
export interface ChatbotUser {
  userId: string;
  role: Role;
  schoolId: string | null;
  email?: string;
}

export interface SendMessageResult {
  chatId: string;
  title: string;
  /** Both new turns, so the client appends without refetching the thread. */
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  /** False when the demo engine fell through to its catch-all. */
  matched: boolean;
}

/**
 * Conversation lifecycle for the demo chatbot.
 *
 * No tenant scoping via `BaseSchoolScopedService` here, deliberately: a chat has
 * no school-owned data in it. It is owned by ONE user, and every store call is
 * keyed by that user's id, which is a stricter boundary than school scoping —
 * a school admin cannot read a colleague's chat either.
 */
@Injectable()
export class ChatbotService {
  constructor(
    private readonly store: ChatStore,
    @Inject(CHATBOT_PROVIDER) private readonly provider: ChatbotProvider,
  ) {}

  /** What the client shows in the header, so the demo is never misrepresented. */
  status(): { provider: string; isLive: boolean; persistent: boolean } {
    return {
      provider: this.provider.name,
      isLive: this.provider.isLive,
      // In-memory: history does not survive an API restart. Say so.
      persistent: false,
    };
  }

  listChats(
    user: ChatbotUser,
    query: PaginationQueryDto,
  ):
    | ChatSummary[]
    | { items: ChatSummary[]; total: number; page: number; pageSize: number } {
    this.store.sweep();
    const all = this.store.list(user.userId).map(toSummary);

    // Same backward-compatible envelope the rest of the API uses: paginated
    // only when the caller asks for a page.
    if (query.page === undefined) return all;
    const { page, pageSize, skip, take } = resolvePagination(query);
    return {
      items: all.slice(skip, skip + take),
      total: all.length,
      page,
      pageSize,
    };
  }

  async createChat(user: ChatbotUser, dto: CreateChatDto): Promise<Chat> {
    this.store.sweep();
    const chat = this.store.create(user.userId);
    if (dto.message?.trim()) {
      await this.sendMessage(user, chat.id, { content: dto.message });
    }
    return this.getChat(user, chat.id);
  }

  getChat(user: ChatbotUser, chatId: string): Chat {
    const chat = this.store.findById(user.userId, chatId);
    // 404 rather than 403 for someone else's chat: the id space is private, and
    // distinguishing "exists but not yours" would confirm it exists.
    if (!chat) throw new NotFoundException('Chat not found');
    return chat;
  }

  async sendMessage(
    user: ChatbotUser,
    chatId: string,
    dto: SendMessageDto,
  ): Promise<SendMessageResult> {
    const chat = this.getChat(user, chatId);
    const question = dto.content.trim();

    const userMessage = this.store.addMessage(
      user.userId,
      chat.id,
      'USER',
      question,
    );
    if (!userMessage) throw new NotFoundException('Chat not found');

    const reply = await this.provider.generateReply({
      question,
      // Excludes the turn just added — the provider gets prior context only.
      history: chat.messages.slice(0, -1),
      role: user.role,
    });

    const assistantMessage = this.store.addMessage(
      user.userId,
      chat.id,
      'ASSISTANT',
      reply.content,
    );
    if (!assistantMessage) throw new NotFoundException('Chat not found');

    return {
      chatId: chat.id,
      title: chat.title,
      userMessage,
      assistantMessage,
      matched: reply.matched,
    };
  }

  deleteChat(user: ChatbotUser, chatId: string): { deleted: true } {
    if (!this.store.delete(user.userId, chatId)) {
      throw new NotFoundException('Chat not found');
    }
    return { deleted: true };
  }
}

function toSummary(chat: Chat): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    messageCount: chat.messages.length,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}
