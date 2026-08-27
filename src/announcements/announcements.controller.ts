import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { ListAnnouncementsQueryDto } from './dto/list-announcements-query.dto';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';
import { AnnouncementIdsDto } from './dto/announcement-ids.dto';

const AUTHOR_ROLES = [
  Role.TEACHER,
  Role.SCHOOL_ADMIN,
  Role.SUPER_ADMIN,
] as const;
const READER_ROLES = [
  Role.STUDENT,
  Role.PARENT,
  Role.TEACHER,
  Role.SCHOOL_ADMIN,
  Role.SUPER_ADMIN,
] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Roles(...AUTHOR_ROLES)
  @Post('attachments/presign')
  presign(@Body() dto: PresignAttachmentDto, @Req() req: any) {
    return this.announcements.presignAttachment(dto, req.user);
  }

  @Roles(...AUTHOR_ROLES)
  @Post()
  create(@Body() dto: CreateAnnouncementDto, @Req() req: any) {
    return this.announcements.create(dto, req.user);
  }

  @Roles(...READER_ROLES)
  @Get()
  list(@Query() query: ListAnnouncementsQueryDto, @Req() req: any) {
    return this.announcements.list(req.user, query);
  }

  @Roles(...READER_ROLES)
  @Get('unread-count')
  unreadCount(@Req() req: any) {
    return this.announcements.unreadCount(req.user);
  }

  // Static PATCH routes are declared BEFORE `:id` so Nest doesn't treat
  // "read-all"/"read"/"dismiss" as an :id.
  @Roles(...READER_ROLES)
  @Patch('read-all')
  markAllRead(@Req() req: any) {
    return this.announcements.markAllRead(req.user);
  }

  @Roles(...READER_ROLES)
  @Patch('read')
  bulkRead(@Body() dto: AnnouncementIdsDto, @Req() req: any) {
    return this.announcements.bulkMarkRead(dto.ids, req.user);
  }

  @Roles(...READER_ROLES)
  @Patch('dismiss')
  bulkDismiss(@Body() dto: AnnouncementIdsDto, @Req() req: any) {
    return this.announcements.bulkDismiss(dto.ids, req.user);
  }

  @Roles(...READER_ROLES)
  @Get(':id')
  get(@Param('id') id: string, @Req() req: any) {
    return this.announcements.get(id, req.user);
  }

  @Roles(...READER_ROLES)
  @Patch(':id/read')
  markRead(@Param('id') id: string, @Req() req: any) {
    return this.announcements.markRead(id, req.user);
  }

  @Roles(...AUTHOR_ROLES)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
    @Req() req: any,
  ) {
    return this.announcements.update(id, dto, req.user);
  }

  @Roles(...AUTHOR_ROLES)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.announcements.remove(id, req.user);
  }
}
