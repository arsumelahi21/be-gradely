import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { ExamSettingsService } from './exam-settings.service';
import {
  CreateGradingSchemeDto,
  CreateTermDto,
  ListTermsQueryDto,
  UpdateGradingSchemeDto,
  UpdateTermDto,
} from './dto/exam-settings.dto';

const uuid = new ParseUUIDPipe({ version: '4' });

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('exam-settings')
export class ExamSettingsController {
  constructor(private readonly settings: ExamSettingsService) {}

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get('terms')
  listTerms(@Query() query: ListTermsQueryDto, @Req() req: any) {
    return this.settings.listTerms(req.user, query.academicYearId);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post('terms')
  createTerm(@Body() dto: CreateTermDto, @Req() req: any) {
    return this.settings.createTerm(dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Patch('terms/:id')
  updateTerm(@Param('id', uuid) id: string, @Body() dto: UpdateTermDto, @Req() req: any) {
    return this.settings.updateTerm(id, dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Delete('terms/:id')
  deleteTerm(@Param('id', uuid) id: string, @Req() req: any) {
    return this.settings.deleteTerm(id, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
  @Get('grading-schemes')
  listSchemes(@Req() req: any) {
    return this.settings.listSchemes(req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post('grading-schemes')
  createScheme(@Body() dto: CreateGradingSchemeDto, @Req() req: any) {
    return this.settings.createScheme(dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Patch('grading-schemes/:id')
  updateScheme(
    @Param('id', uuid) id: string,
    @Body() dto: UpdateGradingSchemeDto,
    @Req() req: any,
  ) {
    return this.settings.updateScheme(id, dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Delete('grading-schemes/:id')
  deleteScheme(@Param('id', uuid) id: string, @Req() req: any) {
    return this.settings.deleteScheme(id, req.user);
  }
}
