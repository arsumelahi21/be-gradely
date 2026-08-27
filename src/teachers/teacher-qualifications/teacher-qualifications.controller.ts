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
import { TeacherQualificationsService } from './teacher-qualifications.service';
import { CreateTeacherQualificationDto } from './dto/create-teacher-qualification.dto';
import { UpdateTeacherQualificationDto } from './dto/update-teacher-qualification.dto';
import { FindQualificationsQueryDto } from './dto/find-qualifications-query.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('teacher-qualifications')
export class TeacherQualificationsController {
  constructor(private readonly qualifications: TeacherQualificationsService) {}

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post()
  create(@Body() dto: CreateTeacherQualificationDto, @Req() req: any) {
    return this.qualifications.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get()
  findAll(@Query() query: FindQualificationsQueryDto, @Req() req: any) {
    return this.qualifications.findAll(req.user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.qualifications.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTeacherQualificationDto,
    @Req() req: any,
  ) {
    return this.qualifications.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.qualifications.remove(id, req.user);
  }
}
