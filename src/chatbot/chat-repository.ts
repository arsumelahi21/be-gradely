import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Chat, ChatMessage, ChatMessageRole } from './chatbot.types';

/**
 * Conversations in Postgres, replacing the in-memory ChatStore (#67).
 *
 * History has to survive a restart and be shared across API instances: a
 * follow-up ("divide them by grade") is only answerable with the prior turns in
 * hand, and an in-memory store loses them on deploy and never shares them.
 *
 * Every method takes `userId` and filters by it, so a chat id alone is never
 * enough to read a conversation — the same object-level rule the old store had.
 */

/** Turns loaded for model context. Older turns stay readable in the UI. */
export const HISTORY_TURNS = 20;
/** Long enough to recognise in the sidebar, short enough not to wrap. */
const TITLE_MAX_LENGTH = 48;
const DEFAULT_TITLE = 'New chat';

@Injectable()
export class ChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    schoolId: string | null,
    title?: string,
  ): Promise<Chat> {
    const chat = await this.prisma.chat.create({
      data: {
        userId,
        schoolId,
        title: title?.trim() ? truncateTitle(title) : DEFAULT_TITLE,
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return toChat(chat);
  }

  /** Newest-first, without message bodies — the sidebar list. */
  async list(userId: string): Promise<Chat[]> {
    const rows = await this.prisma.chat.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return rows.map(toChat);
  }

  async findById(userId: string, chatId: string): Promise<Chat | null> {
    const chat = await this.prisma.chat.findFirst({
      where: { id: chatId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return chat ? toChat(chat) : null;
  }

  async addMessage(
    userId: string,
    chatId: string,
    role: ChatMessageRole,
    content: string,
    toolCalls?: Array<{ name: string; input: unknown }>,
  ): Promise<ChatMessage | null> {
    const owned = await this.prisma.chat.findFirst({
      where: { id: chatId, userId },
      select: { id: true, title: true },
    });
    if (!owned) return null;

    const [message] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: {
          chatId,
          role,
          content,
          toolCalls: toolCalls?.length ? (toolCalls as never) : undefined,
        },
      }),
      // Touch the parent so the sidebar's newest-first order is a column, not a
      // join onto the last message.
      this.prisma.chat.update({
        where: { id: chatId },
        data: {
          updatedAt: new Date(),
          // The first user message names the chat, as every chat app does.
          ...(role === 'USER' && owned.title === DEFAULT_TITLE
            ? { title: truncateTitle(content) }
            : {}),
        },
      }),
    ]);
    return toMessage(message);
  }

  async delete(userId: string, chatId: string): Promise<boolean> {
    // deleteMany, not delete: it filters by userId in the same statement, so
    // another user's id can never match rather than throwing P2025.
    const { count } = await this.prisma.chat.deleteMany({
      where: { id: chatId, userId },
    });
    return count > 0;
  }
}

type ChatRow = {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: MessageRow[];
};

type MessageRow = {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
};

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    ownerUserId: row.userId,
    title: row.title,
    messages: row.messages.map(toMessage),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role as ChatMessageRole,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

function truncateTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return DEFAULT_TITLE;
  return flat.length <= TITLE_MAX_LENGTH
    ? flat
    : `${flat.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}
