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
import { TimetableService } from './timetable.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';
import { UpsertConfigDto } from './dto/upsert-config.dto';
import { SetupTimetableDto } from './dto/setup-timetable.dto';
import { ReplacePeriodsDto } from './dto/replace-periods.dto';
import { CreatePeriodSlotDto } from './dto/create-period-slot.dto';
import { UpdatePeriodSlotDto } from './dto/update-period-slot.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { UpdateEntryDto } from './dto/update-entry.dto';
import { PublishTimetableDto } from './dto/publish-timetable.dto';
import { ApplyTemplateDto } from './dto/apply-template.dto';
import { TeacherOptionsQueryDto } from './dto/teacher-options-query.dto';
import { UpdateTimetableWindowDto } from './dto/update-timetable-window.dto';
import {
  FindTimetableQueryDto,
  MyTimetableQueryDto,
} from './dto/find-timetable-query.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('timetable')
export class TimetableController {
  constructor(private readonly timetable: TimetableService) {}

  // ---- config (school defaults) ----
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('config')
  getConfig(@Query('schoolId') schoolId: string | undefined, @Req() req: any) {
    return this.timetable.getConfig(req.user, schoolId);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Put('config')
  upsertConfig(@Body() dto: UpsertConfigDto, @Req() req: any) {
    return this.timetable.upsertConfig(dto, req.user);
  }

  // ---- overview (admin index) ----
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('overview')
  overview(@Query() query: FindTimetableQueryDto, @Req() req: any) {
    return this.timetable.getOverview(req.user, query);
  }

  // ---- consumer reads (static prefixes before /sections/:id) ----
  @Roles(Role.TEACHER, Role.STUDENT, Role.PARENT)
  @Get('me')
  myTimetable(@Query() query: MyTimetableQueryDto, @Req() req: any) {
    return this.timetable.getMyTimetable(req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get('teacher/:teacherId')
  teacherTimetable(
    @Param('teacherId') teacherId: string,
    @Query() query: FindTimetableQueryDto,
    @Req() req: any,
  ) {
    return this.timetable.getTeacherTimetable(teacherId, req.user, query);
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get('class/:sectionId')
  classTimetable(
    @Param('sectionId') sectionId: string,
    @Query() query: FindTimetableQueryDto,
    @Req() req: any,
  ) {
    return this.timetable.getClassTimetable(sectionId, req.user, query);
  }

  // ---- period mutations (specific before /sections/:id/periods) ----
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch('periods/:id')
  updatePeriod(
    @Param('id') id: string,
    @Body() dto: UpdatePeriodSlotDto,
    @Req() req: any,
  ) {
    return this.timetable.updatePeriod(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete('periods/:id')
  deletePeriod(
    @Param('id') id: string,
    @Query('force') force: string | undefined,
    @Req() req: any,
  ) {
    return this.timetable.deletePeriod(id, req.user, force === 'true');
  }

  // ---- entry mutations ----
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch('entries/:id')
  updateEntry(
    @Param('id') id: string,
    @Body() dto: UpdateEntryDto,
    @Req() req: any,
  ) {
    return this.timetable.updateEntry(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete('entries/:id')
  deleteEntry(@Param('id') id: string, @Req() req: any) {
    return this.timetable.deleteEntry(id, req.user);
  }

  // ---- per-section authoring ----
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('sections/:sectionId')
  sectionTimetable(
    @Param('sectionId') sectionId: string,
    @Query() query: FindTimetableQueryDto,
    @Req() req: any,
  ) {
    return this.timetable.getSectionTimetable(sectionId, req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('sections/:sectionId/setup')
  setup(
    @Param('sectionId') sectionId: string,
    @Body() dto: SetupTimetableDto,
    @Req() req: any,
  ) {
    return this.timetable.setupTimetable(sectionId, dto, req.user);
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  /** The date window this timetable applies to. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch('sections/:sectionId/window')
  updateWindow(
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateTimetableWindowDto,
    @Req() req: any,
  ) {
    return this.timetable.updateWindow(sectionId, dto, req.user);
  }

  @Get('sections/:sectionId/periods')
  listPeriods(
    @Param('sectionId') sectionId: string,
    @Query() query: FindTimetableQueryDto,
    @Req() req: any,
  ) {
    return this.timetable.listPeriods(sectionId, req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('sections/:sectionId/periods')
  createPeriod(
    @Param('sectionId') sectionId: string,
    @Body() dto: CreatePeriodSlotDto,
    @Req() req: any,
  ) {
    return this.timetable.createPeriod(sectionId, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Put('sections/:sectionId/periods')
  replacePeriods(
    @Param('sectionId') sectionId: string,
    @Body() dto: ReplacePeriodsDto,
    @Req() req: any,
  ) {
    return this.timetable.replacePeriods(sectionId, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('sections/:sectionId/teacher-options')
  teacherOptions(
    @Param('sectionId') sectionId: string,
    @Query() query: TeacherOptionsQueryDto,
    @Req() req: any,
  ) {
    return this.timetable.getTeacherOptions(sectionId, query, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('sections/:sectionId/apply-template')
  applyTemplate(
    @Param('sectionId') sectionId: string,
    @Body() dto: ApplyTemplateDto,
    @Req() req: any,
  ) {
    return this.timetable.applyTemplate(sectionId, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('sections/:sectionId/entries')
  createEntry(
    @Param('sectionId') sectionId: string,
    @Body() dto: CreateEntryDto,
    @Req() req: any,
  ) {
    return this.timetable.createEntry(sectionId, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('sections/:sectionId/conflicts/check')
  checkConflicts(
    @Param('sectionId') sectionId: string,
    @Body() dto: CreateEntryDto,
    @Query('excludeEntryId') excludeEntryId: string | undefined,
    @Req() req: any,
  ) {
    return this.timetable.checkConflicts(
      sectionId,
      { ...dto, excludeEntryId },
      req.user,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('sections/:sectionId/validation')
  validation(
    @Param('sectionId') sectionId: string,
    @Query() query: FindTimetableQueryDto,
    @Req() req: any,
  ) {
    return this.timetable.getValidation(sectionId, req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('sections/:sectionId/publish')
  publish(
    @Param('sectionId') sectionId: string,
    @Query() query: FindTimetableQueryDto,
    @Body() body: PublishTimetableDto,
    @Req() req: any,
  ) {
    return this.timetable.publish(sectionId, req.user, query, body);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('sections/:sectionId/archive')
  archive(
    @Param('sectionId') sectionId: string,
    @Query() query: FindTimetableQueryDto,
    @Req() req: any,
  ) {
    return this.timetable.archive(sectionId, req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete('sections/:sectionId')
  deleteTimetable(
    @Param('sectionId') sectionId: string,
    @Query() query: FindTimetableQueryDto,
    // Deleting a PUBLISHED grid needs this — it is live for students.
    @Query('force') force: string | undefined,
    @Req() req: any,
  ) {
    return this.timetable.deleteTimetable(sectionId, req.user, {
      ...query,
      force: force === 'true',
    });
  }
}
