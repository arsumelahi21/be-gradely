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
import { SectionsService } from './sections.service';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';
import { FindSectionsQueryDto } from './dto/find-sections-query.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';
import { LinkTeacherSectionDto } from './dto/link-teacher-section.dto';
import { UpdateTeacherSectionDto } from './dto/update-teacher-section.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sections')
export class SectionsController {
  constructor(private readonly sections: SectionsService) {}

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post()
  create(@Body() dto: CreateSectionDto, @Req() req: any) {
    return this.sections.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get()
  findAll(@Query() query: FindSectionsQueryDto, @Req() req: any) {
    return this.sections.findAll(req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.sections.findOne(id, req.user);
  }

  // One call for the section-management card: subjects + teachers + enrollments
  // (replaces 3 concurrent per-section requests).
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get(':id/detail')
  getDetail(@Param('id') id: string, @Req() req: any) {
    return this.sections.getSectionDetail(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSectionDto,
    @Req() req: any,
  ) {
    return this.sections.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.sections.remove(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get(':id/teachers')
  listTeachers(@Param('id') id: string, @Req() req: any) {
    return this.sections.listTeachers(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post(':id/teachers')
  assignTeacher(
    @Param('id') id: string,
    @Body() dto: LinkTeacherSectionDto,
    @Req() req: any,
  ) {
    return this.sections.assignTeacher(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id/teachers/:assignmentId')
  updateTeacherAssignment(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: UpdateTeacherSectionDto,
    @Req() req: any,
  ) {
    return this.sections.updateTeacherAssignment(
      id,
      assignmentId,
      dto,
      req.user,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id/teachers/:assignmentId')
  removeTeacherAssignment(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Req() req: any,
  ) {
    return this.sections.removeTeacherAssignment(id, assignmentId, req.user);
  }
}
