import type { Role } from '../../common/types/role.type';
import type { ChatMessage } from '../chatbot.types';

/**
 * The seam a real model plugs into.
 *
 * `ChatbotService` depends on this interface and never on a concrete provider,
 * so switching from the demo engine to a hosted model is a one-line `useClass`
 * change in `chatbot.module.ts` — no controller, service or UI edit.
 */
export interface ChatbotProvider {
  /** Shown to the client so the UI can say which engine answered. */
  readonly name: string;
  /** False for the demo engine; a real integration sets this true. */
  readonly isLive: boolean;

  generateReply(input: ChatbotRequest): Promise<ChatbotReply> | ChatbotReply;
}

export interface ChatbotRequest {
  question: string;
  /** Prior turns, oldest-first. The demo engine ignores it; a model would not. */
  history: ChatMessage[];
  /** The asker's role — answers differ for what a teacher can actually do. */
  role: Role;
}

export interface ChatbotReply {
  content: string;
  /** False when nothing matched, so the caller can tell a fallback apart. */
  matched: boolean;
  /** Which intent answered, for debugging and tests. */
  topic?: string;
}

/** DI token — an interface has no runtime identity to inject by. */
export const CHATBOT_PROVIDER = Symbol('CHATBOT_PROVIDER');
