/**
 * Local type mirrors for the demo chatbot (matches the `role.type.ts` convention
 * of hand-written unions rather than generated Prisma enums — nothing here is
 * persisted, so there is no Prisma enum to mirror).
 */

export type ChatMessageRole = 'USER' | 'ASSISTANT';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
}

/** A full conversation, as held in memory and returned by the detail endpoint. */
export interface Chat {
  id: string;
  /** Owner check lives on every read — a chat id alone is never enough. */
  ownerUserId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

/** What the sidebar needs — deliberately without `messages`, so the list is cheap. */
export interface ChatSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}
