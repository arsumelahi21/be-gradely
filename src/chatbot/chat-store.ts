import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Chat, ChatMessage, ChatMessageRole } from './chatbot.types';

/**
 * In-memory conversation store for the DEMO chatbot.
 *
 * Deliberately not Prisma: a demo should not add tables (and this repo already
 * carries an uncaptured schema change), and keeping it in memory makes the whole
 * module a delete rather than a migration to remove. The trade-off is explicit:
 * **history is lost on API restart and is not shared across instances.** The UI
 * says so. Swapping in persistence later means reimplementing this class behind
 * the same methods — nothing above it changes.
 *
 * Every method takes `userId` and filters by it, so a chat id on its own is never
 * sufficient to read a conversation. That is the object-level authorization.
 */

/** Per-user cap; the oldest chat is evicted past this. */
export const MAX_CHATS_PER_USER = 20;
/** Per-chat cap; the oldest messages are dropped past this. */
export const MAX_MESSAGES_PER_CHAT = 100;
/** Idle conversations are swept after this long, so memory can't creep. */
export const CHAT_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * Floor between full sweeps. The sweep walks every user, so running it on each
 * request made a sidebar load O(all users); never running it (the old code only
 * swept on list/create) let an idle process hold every user's chats until restart.
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Shared empty result for users with no chats — never mutated. */
const EMPTY: Chat[] = [];

const DEFAULT_TITLE = 'New chat';
/** Long enough to be recognisable in the sidebar, short enough not to wrap. */
const TITLE_MAX_LENGTH = 48;

@Injectable()
export class ChatStore {
  private readonly byUser = new Map<string, Chat[]>();
  private lastSweep = 0;

  create(userId: string, title?: string): Chat {
    const now = new Date().toISOString();
    const chat: Chat = {
      id: randomUUID(),
      ownerUserId: userId,
      title: title?.trim() ? truncateTitle(title) : DEFAULT_TITLE,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    const chats = this.own(userId);
    chats.unshift(chat);
    // Evict from the tail: the list is newest-first, so the oldest is last.
    if (chats.length > MAX_CHATS_PER_USER) {
      chats.length = MAX_CHATS_PER_USER;
    }
    return chat;
  }

  /** Newest-first. Returns a copy so callers can't mutate the store. */
  list(userId: string): Chat[] {
    return [...this.read(userId)];
  }

  findById(userId: string, chatId: string): Chat | null {
    return this.read(userId).find((c) => c.id === chatId) ?? null;
  }

  addMessage(
    userId: string,
    chatId: string,
    role: ChatMessageRole,
    content: string,
  ): ChatMessage | null {
    const chat = this.read(userId).find((c) => c.id === chatId) ?? null;
    if (!chat) return null;

    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    chat.messages.push(message);
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }

    // The first user message names the chat, the way every chat app does it.
    if (role === 'USER' && chat.title === DEFAULT_TITLE) {
      chat.title = truncateTitle(content);
    }
    chat.updatedAt = message.createdAt;

    // Keep the list newest-first without a sort on every read.
    const chats = this.own(userId);
    const at = chats.indexOf(chat);
    if (at > 0) {
      chats.splice(at, 1);
      chats.unshift(chat);
    }
    return message;
  }

  delete(userId: string, chatId: string): boolean {
    const chats = this.read(userId);
    const at = chats.findIndex((c) => c.id === chatId);
    if (at === -1) return false;
    chats.splice(at, 1);
    if (chats.length === 0) this.byUser.delete(userId);
    return true;
  }

  /**
   * Sweeps at most every SWEEP_INTERVAL_MS. Called from every entry point, so a
   * process that only serves sendMessage still reclaims memory.
   */
  maybeSweep(now = Date.now()): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    this.sweep(now);
  }

  /**
   * Drops conversations untouched for longer than the TTL. Called on access
   * rather than on a timer — no interval to leak, and an idle process does no
   * work at all.
   */
  sweep(now = Date.now()): void {
    for (const [userId, chats] of this.byUser) {
      const live = chats.filter(
        (c) => now - Date.parse(c.updatedAt) < CHAT_TTL_MS,
      );
      if (live.length === 0) this.byUser.delete(userId);
      else if (live.length !== chats.length) this.byUser.set(userId, live);
    }
  }

  /** Users currently holding chats — the store's real memory footprint. */
  userCount(): number {
    return this.byUser.size;
  }

  /** Reads never allocate: `own()` used to insert, so a GET from a user who has
   * never chatted left a permanent Map entry behind. */
  private read(userId: string): Chat[] {
    return this.byUser.get(userId) ?? EMPTY;
  }

  private own(userId: string): Chat[] {
    let chats = this.byUser.get(userId);
    if (!chats) {
      chats = [];
      this.byUser.set(userId, chats);
    }
    return chats;
  }
}

function truncateTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return DEFAULT_TITLE;
  return flat.length <= TITLE_MAX_LENGTH
    ? flat
    : `${flat.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}
