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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { SchoolsService } from './schools.service';
import { CreateSchoolDto } from './dto/create-school.dto';
import { UpdateSchoolDto } from './dto/update-school.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('schools')
export class SchoolsController {
  constructor(private schools: SchoolsService) {}

  // ---- School branding logo (principal self-service; bytes in SchoolLogo) ----
  // `me/logo` resolves the caller's own school, so a principal can only touch theirs.

  @Roles(Role.SCHOOL_ADMIN)
  @Post('me/logo')
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    }),
  )
  uploadMyLogo(
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
    @Req() req: any,
  ) {
    return this.schools.uploadLogo(req.user?.schoolId, file);
  }

  // No @Roles: any authenticated user may display their own school's logo.
  @Get('me/logo')
  async getMyLogo(@Req() req: any, @Res() res: Response) {
    const { data, mimeType } = await this.schools.getLogo(req.user?.schoolId);
    res.setHeader('Content-Type', mimeType);
    // Never cache: a re-uploaded logo must show everywhere on the next fetch.
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Delete('me/logo')
  deleteMyLogo(@Req() req: any) {
    return this.schools.deleteLogo(req.user?.schoolId);
  }

  @Roles(Role.SUPER_ADMIN)
  @Post()
  create(@Body() dto: CreateSchoolDto) {
    return this.schools.create(dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Get()
  findAll(@Query() query: any) {
    return this.schools.findAll({
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
      search: query.search,
    });
  }

  @Roles(Role.SUPER_ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.schools.findOne(id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSchoolDto) {
    return this.schools.update(id, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.schools.remove(id);
  }
}
