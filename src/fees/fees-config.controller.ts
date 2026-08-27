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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { FeeSettingsService } from './fee-settings.service';
import { FeeHeadsService } from './fee-heads.service';
import { BankAccountsService } from './bank-accounts.service';
import { DiscountsService } from './discounts.service';
import { UpdateFeeSettingsDto } from './dto/update-fee-settings.dto';
import { CreateFeeHeadDto } from './dto/create-fee-head.dto';
import { UpdateFeeHeadDto } from './dto/update-fee-head.dto';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import { CreateDiscountDto } from './dto/create-discount.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';

const listOpts = (q: any) => ({
  page: q.page ? Number(q.page) : undefined,
  pageSize: q.pageSize ? Number(q.pageSize) : undefined,
  search: q.search,
  activeOnly: q.activeOnly === 'true' || q.activeOnly === true,
});

/**
 * Fee configuration: school settings, fee heads, bank accounts, discounts.
 * Admin-only throughout — no read path here is exposed to other roles.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('fees')
export class FeesConfigController {
  constructor(
    private readonly settings: FeeSettingsService,
    private readonly feeHeads: FeeHeadsService,
    private readonly bankAccounts: BankAccountsService,
    private readonly discounts: DiscountsService,
  ) {}

  // ---- Settings ----------------------------------------------------------

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('settings')
  getSettings(@Query('schoolId') schoolId: string, @Req() req: any) {
    return this.settings.get(req.user, schoolId);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch('settings')
  updateSettings(@Body() dto: UpdateFeeSettingsDto, @Req() req: any) {
    return this.settings.update(dto, req.user);
  }

  // ---- Fee heads ---------------------------------------------------------

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('heads')
  listHeads(@Query() query: any, @Req() req: any) {
    return this.feeHeads.findAll(req.user, query.schoolId, listOpts(query));
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('heads')
  createHead(@Body() dto: CreateFeeHeadDto, @Req() req: any) {
    return this.feeHeads.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('heads/:id')
  getHead(@Param('id') id: string, @Req() req: any) {
    return this.feeHeads.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch('heads/:id')
  updateHead(
    @Param('id') id: string,
    @Body() dto: UpdateFeeHeadDto,
    @Req() req: any,
  ) {
    return this.feeHeads.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete('heads/:id')
  removeHead(@Param('id') id: string, @Req() req: any) {
    return this.feeHeads.remove(id, req.user);
  }

  // ---- Bank accounts -----------------------------------------------------

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('bank-accounts')
  listBankAccounts(@Query() query: any, @Req() req: any) {
    return this.bankAccounts.findAll(req.user, query.schoolId, listOpts(query));
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('bank-accounts')
  createBankAccount(@Body() dto: CreateBankAccountDto, @Req() req: any) {
    return this.bankAccounts.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('bank-accounts/:id')
  getBankAccount(@Param('id') id: string, @Req() req: any) {
    return this.bankAccounts.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch('bank-accounts/:id')
  updateBankAccount(
    @Param('id') id: string,
    @Body() dto: UpdateBankAccountDto,
    @Req() req: any,
  ) {
    return this.bankAccounts.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete('bank-accounts/:id')
  removeBankAccount(@Param('id') id: string, @Req() req: any) {
    return this.bankAccounts.remove(id, req.user);
  }

  // ---- Discounts ---------------------------------------------------------

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('discounts')
  listDiscounts(@Query() query: any, @Req() req: any) {
    return this.discounts.findAll(req.user, query.schoolId, listOpts(query));
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('discounts')
  createDiscount(@Body() dto: CreateDiscountDto, @Req() req: any) {
    return this.discounts.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('discounts/:id')
  getDiscount(@Param('id') id: string, @Req() req: any) {
    return this.discounts.findOne(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('discounts/:id/assigned-count')
  discountAssignedCount(@Param('id') id: string, @Req() req: any) {
    return this.discounts.assignedCount(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch('discounts/:id')
  updateDiscount(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountDto,
    @Req() req: any,
  ) {
    return this.discounts.update(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete('discounts/:id')
  removeDiscount(@Param('id') id: string, @Req() req: any) {
    return this.discounts.remove(id, req.user);
  }
}
