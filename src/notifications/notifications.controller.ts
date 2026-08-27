import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { MarkNotificationsReadDto } from './dto/mark-notifications-read.dto';

const ALL_ROLES = [
  Role.STUDENT,
  Role.PARENT,
  Role.TEACHER,
  Role.SCHOOL_ADMIN,
  Role.SUPER_ADMIN,
] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Roles(...ALL_ROLES)
  @Get()
  list(@Query() query: ListNotificationsQueryDto, @Req() req: any) {
    return this.notifications.list(req.user, query);
  }

  @Roles(...ALL_ROLES)
  @Get('unread-count')
  unreadCount(@Req() req: any, @Query('since') since?: string) {
    return this.notifications.unreadCount(req.user, since);
  }

  // Bulk dismiss (per-category "Clear all"). Removes only the notification rows.
  @Roles(...ALL_ROLES)
  @Delete()
  dismissMany(@Body() dto: MarkNotificationsReadDto, @Req() req: any) {
    return this.notifications.dismiss(dto.ids, req.user);
  }

  // Dismiss a single notification from the list.
  @Roles(...ALL_ROLES)
  @Delete(':id')
  dismiss(@Param('id') id: string, @Req() req: any) {
    return this.notifications.dismiss([id], req.user);
  }

  @Roles(...ALL_ROLES)
  @Patch('read-all')
  markAllRead(@Req() req: any) {
    return this.notifications.markAllRead(req.user);
  }

  // Bulk mark-as-read by id (per-category "mark all read"). Declared before
  // ':id/read' — distinct single-segment path, so no route clash.
  @Roles(...ALL_ROLES)
  @Patch('read')
  markMany(@Body() dto: MarkNotificationsReadDto, @Req() req: any) {
    return this.notifications.markManyRead(dto.ids, req.user);
  }

  @Roles(...ALL_ROLES)
  @Patch(':id/read')
  markRead(@Param('id') id: string, @Req() req: any) {
    return this.notifications.markRead(id, req.user);
  }
}
