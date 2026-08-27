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
import { StudentsService } from './students.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';
import { LinkStudentParentDto } from './dto/link-student-parent.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  /**
   * @deprecated Not the canonical path — the frontend creates students via `POST /users`
   * instead. Retained only for existing callers; do not extend this path further.
   */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post()
  create(@Body() dto: CreateStudentDto, @Req() req: any) {
    return this.students.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get()
  findAll(
    @Query('schoolId') schoolId: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: any,
  ) {
    return this.students.findAll(req.user, schoolId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.students.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStudentDto,
    @Req() req: any,
  ) {
    return this.students.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.students.remove(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get(':id/parents')
  listParents(@Param('id') id: string, @Req() req: any) {
    return this.students.listParents(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post(':id/parents')
  linkParent(
    @Param('id') id: string,
    @Body() dto: LinkStudentParentDto,
    @Req() req: any,
  ) {
    return this.students.linkParent(id, dto.parentProfileId, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id/parents/:parentProfileId')
  unlinkParent(
    @Param('id') id: string,
    @Param('parentProfileId') parentProfileId: string,
    @Req() req: any,
  ) {
    return this.students.unlinkParent(id, parentProfileId, req.user);
  }
}
