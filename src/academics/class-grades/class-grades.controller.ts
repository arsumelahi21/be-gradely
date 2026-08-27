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
import { ClassGradesService } from './class-grades.service';
import { CreateClassGradeDto } from './dto/create-class-grade.dto';
import { UpdateClassGradeDto } from './dto/update-class-grade.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('class-grades')
export class ClassGradesController {
  constructor(private readonly classGrades: ClassGradesService) {}

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post()
  create(@Body() dto: CreateClassGradeDto, @Req() req: any) {
    return this.classGrades.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get()
  findAll(@Query() query: any, @Req() req: any) {
    return this.classGrades.findAll(req.user, query.schoolId, {
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
      search: query.search,
    });
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.classGrades.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateClassGradeDto,
    @Req() req: any,
  ) {
    return this.classGrades.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.classGrades.remove(id, req.user);
  }
}
