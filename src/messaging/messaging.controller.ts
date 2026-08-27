import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MessagingService } from './messaging.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { CreateThreadDto } from './dto/create-thread.dto';
import { BroadcastMessageDto } from './dto/broadcast-message.dto';
import { AddParticipantsDto } from './dto/add-participants.dto';
import { UpdateThreadDto } from './dto/update-thread.dto';
import { ReportUserDto } from './dto/report-user.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { ReactionDto } from './dto/reaction.dto';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

// Every role participates in messaging; the service enforces the finer
// permission matrix + object-level (shared-section / participant) checks.
const MESSAGING_ROLES = [
  Role.STUDENT,
  Role.PARENT,
  Role.TEACHER,
  Role.SCHOOL_ADMIN,
  Role.SUPER_ADMIN,
] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('messaging')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Roles(...MESSAGING_ROLES)
  @Post('threads')
  createThread(@Body() dto: CreateThreadDto, @Req() req: any) {
    return this.messaging.createThread(dto, req.user);
  }

  @Roles(...MESSAGING_ROLES)
  @Get('threads')
  listThreads(@Query() query: PaginationQueryDto, @Req() req: any) {
    return this.messaging.listThreads(req.user, query);
  }

  // Users the caller may start a DIRECT thread with (permission-matrix +
  // shared-section filtered) — feeds the frontend recipient picker.
  // Unread badge for the top-bar message icon. Distinct static path (not under
  // threads/:id) so no param collision; mirrors /notifications/unread-count.
  @Roles(...MESSAGING_ROLES)
  @Get('unread-count')
  getUnreadCount(@Req() req: any) {
    return this.messaging.getUnreadCount(req.user);
  }

  @Roles(...MESSAGING_ROLES)
  @Get('recipients')
  listRecipients(@Req() req: any) {
    return this.messaging.listRecipients(req.user);
  }

  // Staff-only: "send the same message to each recipient individually" (fan-out
  // to separate 1:1 threads). Same tight write throttle as sendMessage.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Post('broadcast')
  broadcast(@Body() dto: BroadcastMessageDto, @Req() req: any) {
    return this.messaging.broadcast(dto, req.user);
  }

  // Staff-only: sections the caller may message + a section's grouped roster —
  // feed the "message a class/section" flow.
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get('sections')
  listMessagingSections(@Req() req: any) {
    return this.messaging.listMessagingSections(req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Get('sections/:id/roster')
  getSectionRoster(@Param('id') id: string, @Req() req: any) {
    return this.messaging.getSectionRoster(id, req.user);
  }

  // Staff-only: manage a GROUP thread's membership.
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Post('threads/:id/participants')
  addParticipants(
    @Param('id') id: string,
    @Body() dto: AddParticipantsDto,
    @Req() req: any,
  ) {
    return this.messaging.addGroupParticipants(id, dto.userIds, req.user);
  }

  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Delete('threads/:id/participants/:userId')
  removeParticipant(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    return this.messaging.removeGroupParticipant(id, userId, req.user);
  }

  @Roles(...MESSAGING_ROLES)
  @Get('threads/:id')
  getThread(@Param('id') id: string, @Req() req: any) {
    return this.messaging.getThread(id, req.user);
  }

  @Roles(...MESSAGING_ROLES)
  @Get('threads/:id/messages')
  getMessages(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
    @Req() req: any,
  ) {
    return this.messaging.getMessages(id, req.user, query);
  }

  // Tighter rate limit on the write path (Phase 1 §1.5.1 throttle pattern).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Roles(...MESSAGING_ROLES)
  @Post('threads/:id/messages')
  sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @Req() req: any,
  ) {
    return this.messaging.sendMessage(id, dto, req.user);
  }

  // Edit the body of a message you sent.
  @Roles(...MESSAGING_ROLES)
  @Patch('threads/:id/messages/:messageId')
  editMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() dto: EditMessageDto,
    @Req() req: any,
  ) {
    return this.messaging.editMessage(id, messageId, dto, req.user);
  }

  // Delete a message. `?scope=me` (default) hides it for the caller only;
  // `?scope=everyone` unsends it for everyone (sender only).
  @Roles(...MESSAGING_ROLES)
  @Delete('threads/:id/messages/:messageId')
  deleteMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Query('scope') scope: string,
    @Req() req: any,
  ) {
    return scope === 'everyone'
      ? this.messaging.unsendMessage(id, messageId, req.user)
      : this.messaging.deleteMessageForMe(id, messageId, req.user);
  }

  // Add or replace the caller's emoji reaction (one per person).
  @Roles(...MESSAGING_ROLES)
  @Put('threads/:id/messages/:messageId/reaction')
  reactToMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() dto: ReactionDto,
    @Req() req: any,
  ) {
    return this.messaging.reactToMessage(id, messageId, dto, req.user);
  }

  // Remove the caller's reaction.
  @Roles(...MESSAGING_ROLES)
  @Delete('threads/:id/messages/:messageId/reaction')
  unreactMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Req() req: any,
  ) {
    return this.messaging.unreactMessage(id, messageId, req.user);
  }

  @Roles(...MESSAGING_ROLES)
  @Post('threads/:id/attachments')
  presignAttachment(
    @Param('id') id: string,
    @Body() dto: PresignAttachmentDto,
    @Req() req: any,
  ) {
    return this.messaging.presignAttachment(id, dto, req.user);
  }

  @Roles(...MESSAGING_ROLES)
  @Patch('threads/:id/read')
  markRead(@Param('id') id: string, @Req() req: any) {
    return this.messaging.markRead(id, req.user);
  }

  // Rename a GROUP thread (staff, service-enforced).
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)
  @Patch('threads/:id')
  renameThread(
    @Param('id') id: string,
    @Body() dto: UpdateThreadDto,
    @Req() req: any,
  ) {
    return this.messaging.renameGroup(id, dto.title, req.user);
  }

  // Leave / delete a thread from the caller's own list.
  @Roles(...MESSAGING_ROLES)
  @Delete('threads/:id')
  leaveThread(@Param('id') id: string, @Req() req: any) {
    return this.messaging.leaveThread(id, req.user);
  }

  // Report a user to the school's admins.
  @Roles(...MESSAGING_ROLES)
  @Post('report')
  reportUser(@Body() dto: ReportUserDto, @Req() req: any) {
    return this.messaging.reportUser(dto, req.user);
  }
}
