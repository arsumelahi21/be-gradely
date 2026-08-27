import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ChatbotService } from './chatbot.service';
import { CreateChatDto } from './dto/create-chat.dto';
import { SendMessageDto } from './dto/send-message.dto';

/**
 * DEMO chatbot API.
 *
 * Authorization is server-side and mandatory: the class-level guards plus
 * `@Roles(...)` on every handler. Hiding the button on the frontend is UX, not
 * a boundary — a STUDENT or PARENT calling these routes directly gets a 403.
 *
 * The controller does routing, auth and validation only. Every answer comes from
 * `ChatbotService` → the injected provider; no chatbot logic lives here.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('chatbot')
export class ChatbotController {
  constructor(private readonly chatbot: ChatbotService) {}

  /** Which engine is answering — lets the UI state plainly that it is a demo. */
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get('status')
  status() {
    return this.chatbot.status();
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get('chats')
  listChats(@Query() query: PaginationQueryDto, @Req() req: any) {
    return this.chatbot.listChats(req.user, query);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Post('chats')
  createChat(@Body() dto: CreateChatDto, @Req() req: any) {
    return this.chatbot.createChat(req.user, dto);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get('chats/:id')
  getChat(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.chatbot.getChat(req.user, id);
  }

  // Tighter than the global 100/min: one question per turn is plenty, and this
  // is the only handler that does real work.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Post('chats/:id/messages')
  sendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Req() req: any,
  ) {
    return this.chatbot.sendMessage(req.user, id, dto);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Delete('chats/:id')
  deleteChat(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.chatbot.deleteChat(req.user, id);
  }
}
