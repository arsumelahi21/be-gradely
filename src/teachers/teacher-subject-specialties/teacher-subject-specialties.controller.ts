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
import { TeacherSubjectSpecialtiesService } from './teacher-subject-specialties.service';
import { CreateTeacherSubjectSpecialtyDto } from './dto/create-teacher-subject-specialty.dto';
import { UpdateTeacherSubjectSpecialtyDto } from './dto/update-teacher-subject-specialty.dto';
import { FindSpecialtiesQueryDto } from './dto/find-specialties-query.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('teacher-specialties')
export class TeacherSubjectSpecialtiesController {
  constructor(private readonly specialties: TeacherSubjectSpecialtiesService) {}

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post()
  create(@Body() dto: CreateTeacherSubjectSpecialtyDto, @Req() req: any) {
    return this.specialties.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get()
  findAll(@Query() query: FindSpecialtiesQueryDto, @Req() req: any) {
    return this.specialties.findAll(req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.specialties.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTeacherSubjectSpecialtyDto,
    @Req() req: any,
  ) {
    return this.specialties.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.specialties.remove(id, req.user);
  }
}
