import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PaginationQueryDto,
  resolvePagination,
} from '../common/dto/pagination-query.dto';
import { Role } from '../common/types/role.type';
import { ChatRepository, HISTORY_TURNS } from './chat-repository';
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
  /** False when the engine fell through to its catch-all. */
  matched: boolean;
}

/**
 * Conversation lifecycle.
 *
 * No tenant scoping via `BaseSchoolScopedService` here, deliberately: a chat has
 * no school-owned data in it. It is owned by ONE user, and every repository call
 * is keyed by that user's id, which is a stricter boundary than school scoping —
 * a school admin cannot read a colleague's chat either.
 */
@Injectable()
export class ChatbotService {
  constructor(
    private readonly chats: ChatRepository,
    @Inject(CHATBOT_PROVIDER) private readonly provider: ChatbotProvider,
  ) {}

  /** What the client shows in the header, so the engine is never misrepresented. */
  status(): { provider: string; isLive: boolean; persistent: boolean } {
    return {
      provider: this.provider.name,
      isLive: this.provider.isLive,
      persistent: true,
    };
  }

  async listChats(
    user: ChatbotUser,
    query: PaginationQueryDto,
  ): Promise<
    | ChatSummary[]
    | { items: ChatSummary[]; total: number; page: number; pageSize: number }
  > {
    const all = (await this.chats.list(user.userId)).map(toSummary);

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
    const chat = await this.chats.create(user.userId, user.schoolId);
    if (dto.message?.trim()) {
      await this.sendMessage(user, chat.id, { content: dto.message });
    }
    return this.getChat(user, chat.id);
  }

  async getChat(user: ChatbotUser, chatId: string): Promise<Chat> {
    const chat = await this.chats.findById(user.userId, chatId);
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
    const chat = await this.getChat(user, chatId);
    const question = dto.content.trim();

    const userMessage = await this.chats.addMessage(
      user.userId,
      chat.id,
      'USER',
      question,
    );
    if (!userMessage) throw new NotFoundException('Chat not found');

    const reply = await this.provider.generateReply({
      question,
      // Excludes the turn just added — the provider gets prior context only.
      // Capped so a long conversation can't grow the prompt without bound.
      history: chat.messages.slice(-HISTORY_TURNS),
      role: user.role,
      // Data-backed answers run as the asker, through the same scoped services
      // the REST API uses.
      actor: {
        userId: user.userId,
        role: user.role,
        schoolId: user.schoolId,
      },
    });

    const assistantMessage = await this.chats.addMessage(
      user.userId,
      chat.id,
      'ASSISTANT',
      reply.content,
      reply.toolCalls,
    );
    if (!assistantMessage) throw new NotFoundException('Chat not found');

    // The first user message renames the chat, so the title loaded before the
    // write is stale — re-read it rather than echoing the old one.
    const saved = await this.chats.findById(user.userId, chat.id);

    return {
      chatId: chat.id,
      title: saved?.title ?? chat.title,
      userMessage,
      assistantMessage,
      matched: reply.matched,
    };
  }

  async deleteChat(
    user: ChatbotUser,
    chatId: string,
  ): Promise<{ deleted: true }> {
    if (!(await this.chats.delete(user.userId, chatId))) {
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
