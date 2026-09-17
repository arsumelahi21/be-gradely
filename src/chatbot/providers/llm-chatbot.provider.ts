import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ChatbotAppDataService } from '../app-data.service';
import { toolsFor } from '../tools';
import { Role } from '../../common/types/role.type';
import { AppDataChatbotProvider } from './app-data-chatbot.provider';
import type {
  ChatbotProvider,
  ChatbotReply,
  ChatbotRequest,
} from './chatbot-provider.interface';

/**
 * The live engine: the model decides WHICH data function answers the question,
 * and writes the sentence. It never reaches data itself — every figure comes
 * back from a tool that ran as the asker through the scoped services.
 *
 * `AppDataChatbotProvider` sits in front as a zero-token classifier: greetings
 * and off-topic questions are answered without a model call at all, and it is
 * also the whole engine when no API key is configured.
 */

/** Tool rounds before we stop. Two is plenty for "count, then split by class". */
const MAX_ROUNDS = 3;
/** Answers are short; this caps the bill as much as the length. */
const MAX_TOKENS = 1024;
/** Factual questions about real data — near-deterministic, not creative. */
const TEMPERATURE = 0.2;

const SYSTEM_PROMPT = `You are the Gradely assistant, inside a school-management web app.

RULES
- Answer ONLY from the tools. Never state a number, name or date that a tool did not return.
- If no tool fits the question, say you can't help with that and name what you can do. Never improvise.
- You are not a general assistant: refuse anything unrelated to this school's data or to using Gradely.
- If a tool returns {"error": ...}, relay that plainly. Do not retry with a different tool to get around it.
- Money is in minor units (paisa). Divide by 100 and write it as "Rs 1,234".
- A field named marksTotal/marksPresent/marksAbsent counts ATTENDANCE MARKS over a period, never students — one pupil marked on five days is five marks. Never label such a figure "students", and never present marksPresent + marksAbsent as a class size. If you need a headcount, call a tool that returns one.
- Be brief. Markdown bullets for lists, bold for figures. No preamble, no "certainly".
- The user cannot see tool names or JSON. Write the answer, not the mechanics.`;

@Injectable()
export class LlmChatbotProvider implements ChatbotProvider {
  readonly name = 'claude';
  readonly isLive = true;

  private readonly logger = new Logger(LlmChatbotProvider.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(
    private readonly data: ChatbotAppDataService,
    private readonly fallback: AppDataChatbotProvider,
  ) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
  }

  async generateReply(req: ChatbotRequest): Promise<ChatbotReply> {
    const tools = toolsFor(req.role);
    if (!tools.length) return this.fallback.generateReply(req);

    const used: Array<{ name: string; input: unknown }> = [];
    const messages: Anthropic.MessageParam[] = [
      ...req.history.map((m) => ({
        role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      })),
      { role: 'user', content: req.question },
    ];

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          system: `${SYSTEM_PROMPT}\n\n${this.persona(req)}`,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input as Anthropic.Tool.InputSchema,
          })),
          messages,
        });

        const calls = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );

        if (!calls.length) {
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (!text) break;
          return {
            content: text,
            matched: true,
            topic: used.length ? `llm:${used[0].name}` : 'llm',
            toolCalls: used.length ? used : undefined,
          };
        }

        messages.push({ role: 'assistant', content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of calls) {
          const tool = tools.find((t) => t.name === call.name);
          // A tool outside this role's list can only mean the model invented a
          // name; say so rather than silently returning nothing.
          const output = tool
            ? await tool.run(
                this.data,
                req.actor,
                (call.input ?? {}) as Record<string, any>,
              )
            : { error: 'No such tool.' };
          used.push({ name: call.name, input: call.input });
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(output),
          });
        }
        messages.push({ role: 'user', content: results });
      }

      this.logger.warn(`no answer after ${MAX_ROUNDS} tool rounds`);
      return this.fallback.generateReply(req);
    } catch (e) {
      // A model outage must not take the assistant down: fall back to the
      // deterministic engine, which answers the common questions anyway.
      this.logger.warn(`model call failed: ${(e as Error).message}`);
      return this.fallback.generateReply(req);
    }
  }

  /** Who is asking — so the model tailors, and knows what it may not offer. */
  private persona(req: ChatbotRequest): string {
    const role =
      req.role === Role.TEACHER
        ? 'a TEACHER: they see only their own classes, students and timetable, and have no access to fees or school-wide totals'
        : 'a SCHOOL ADMIN (principal): they see the whole school, including fees';
    return `The person asking is ${role}. Today is ${new Date().toISOString().slice(0, 10)}.`;
  }
}
