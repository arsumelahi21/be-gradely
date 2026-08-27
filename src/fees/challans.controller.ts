import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { ChallansService } from './challans.service';
import { PaymentsService } from './payments.service';
import { FeeReportsService } from './fee-reports.service';
import { StudentFeeHeadsService } from './student-fee-heads.service';
import { InstallmentPlansService } from './installment-plans.service';
import { PaymentSubmissionsService } from './payment-submissions.service';
import { FeeReportQueryDto } from './dto/fee-report-query.dto';
import { SetStudentFeeHeadsDto } from './dto/student-fee-heads.dto';
import { SetInstallmentPlanDto } from './dto/installment-plan.dto';
import {
  CreatePaymentSubmissionDto,
  PaymentSubmissionQueryDto,
  RejectPaymentSubmissionDto,
} from './dto/payment-submission.dto';
import { GenerateChallansDto } from './dto/generate-challans.dto';
import { CreateChallanDto } from './dto/create-challan.dto';
import {
  ChallanCoverageQueryDto,
  ChallanQueryDto,
  SectionInstallmentQueryDto,
  StudentFeeStatusDto,
} from './dto/challan-query.dto';
import {
  CancelChallanDto,
  RecordPaymentDto,
  VoidPaymentDto,
} from './dto/record-payment.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('fees')
export class ChallansController {
  constructor(
    private readonly challans: ChallansService,
    private readonly payments: PaymentsService,
    private readonly reports: FeeReportsService,
    private readonly studentHeads: StudentFeeHeadsService,
    private readonly installmentPlans: InstallmentPlansService,
    private readonly submissions: PaymentSubmissionsService,
  ) {}

  // ---- Online payment proof ----------------------------------------------

  /**
   * Student/parent uploads proof. Multipart so the SERVER sees the bytes and
   * can validate the real type and size — a presigned direct-to-S3 upload
   * cannot, which matters for financial evidence.
   */
  @Roles(Role.STUDENT, Role.PARENT)
  @Post('challans/:id/payment-submissions')
  @UseInterceptors(
    FileInterceptor('receipt', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    }),
  )
  submitPayment(
    @Param('id') challanId: string,
    @Body() dto: CreatePaymentSubmissionDto,
    @UploadedFile()
    file:
      | { buffer: Buffer; mimetype: string; originalname?: string }
      | undefined,
    @Req() req: any,
  ) {
    return this.submissions.submit(challanId, dto, file, req.user);
  }

  /** The verification queue. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('payment-submissions')
  listSubmissions(@Query() query: PaymentSubmissionQueryDto, @Req() req: any) {
    return this.submissions.list(query, req.user);
  }

  /** Submissions on one challan — object-level scoped. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.PARENT, Role.STUDENT)
  @Get('challans/:id/payment-submissions')
  challanSubmissions(@Param('id') challanId: string, @Req() req: any) {
    return this.submissions.listForChallan(challanId, req.user);
  }

  /** Streams the receipt through the API so the file inherits the record's auth. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.PARENT, Role.STUDENT)
  @Get('payment-submissions/:id/receipt')
  async submissionReceipt(
    @Param('id') id: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const { data, mimeType } = await this.submissions.receipt(id, req.user);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }

  /** Verify -> creates the real Payment via the existing workflow. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('payment-submissions/:id/verify')
  verifySubmission(@Param('id') id: string, @Req() req: any) {
    return this.submissions.verify(id, req.user);
  }

  /** Reject -> creates nothing. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('payment-submissions/:id/reject')
  rejectSubmission(
    @Param('id') id: string,
    @Body() dto: RejectPaymentSubmissionDto,
    @Req() req: any,
  ) {
    return this.submissions.reject(id, dto, req.user);
  }

  /**
   * Batch fee status for the student-list badge. POST because it carries a
   * list of ids, not because it mutates anything.
   */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('students/status')
  batchStatus(@Body() dto: StudentFeeStatusDto, @Req() req: any) {
    return this.challans.batchStatus(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('challans/preview')
  preview(@Body() dto: GenerateChallansDto, @Req() req: any) {
    return this.challans.preview(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('challans/generate')
  generate(@Body() dto: GenerateChallansDto, @Req() req: any) {
    return this.challans.generate(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('challans')
  createSingle(@Body() dto: CreateChallanDto, @Req() req: any) {
    return this.challans.createSingle(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('challans')
  list(@Query() query: ChallanQueryDto, @Req() req: any) {
    return this.challans.list(query, req.user);
  }

  // Declared BEFORE `challans/:id` so "coverage" isn't captured as an id.
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('challans/coverage')
  coverage(@Query() query: ChallanCoverageQueryDto, @Req() req: any) {
    return this.challans.coverage(query, req.user);
  }

  /** Full detail for a filtered set — printing a whole class in one go. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('challans/print')
  printBatch(@Query() query: ChallanQueryDto, @Req() req: any) {
    return this.challans.printBatch(query, req.user);
  }

  /** Which installment rows a whole section can be billed for. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('challans/installment-options')
  sectionInstallmentOptions(
    @Query() query: SectionInstallmentQueryDto,
    @Req() req: any,
  ) {
    return this.challans.sectionInstallmentOptions(query, req.user);
  }

  /** Object-level scoped: a parent can only read their own child's challan. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.PARENT, Role.STUDENT)
  @Get('challans/:id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.challans.findOne(id, req.user);
  }

  // ---- Payments ----------------------------------------------------------

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('challans/:id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelChallanDto,
    @Req() req: any,
  ) {
    return this.payments.cancelChallan(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('challans/:id/payments')
  recordPayment(
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
    @Req() req: any,
  ) {
    return this.payments.record(id, dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('challans/:id/payments')
  listPayments(@Param('id') id: string, @Req() req: any) {
    return this.payments.listForChallan(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('payments/:id/void')
  voidPayment(
    @Param('id') id: string,
    @Body() dto: VoidPaymentDto,
    @Req() req: any,
  ) {
    return this.payments.void(id, dto, req.user);
  }

  // ---- One student's fee heads (admin only) ------------------------------

  /** Effective heads for a student: school defaults + their overrides. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('students/:studentId/fee-heads')
  studentFeeHeads(@Param('studentId') studentId: string, @Req() req: any) {
    return this.studentHeads.list(studentId, req.user);
  }

  /** Replaces this student's overrides only — never the school-wide config. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Put('students/:studentId/fee-heads')
  setStudentFeeHeads(
    @Param('studentId') studentId: string,
    @Body() dto: SetStudentFeeHeadsDto,
    @Req() req: any,
  ) {
    return this.studentHeads.set(studentId, dto, req.user);
  }

  // ---- One student's installment plan ------------------------------------

  /**
   * Everything the "Generate Installment Challan" modal shows: the student's
   * plans, their rows, and which rows are already billed.
   */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('students/:studentId/installment-options')
  installmentOptions(@Param('studentId') studentId: string, @Req() req: any) {
    return this.challans.installmentOptions(studentId, req.user);
  }

  /** Read-only for TEACHER/PARENT/STUDENT; object-level scoped, not role-gated alone. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.PARENT, Role.STUDENT)
  @Get('students/:studentId/installment-plan')
  installmentPlan(@Param('studentId') studentId: string, @Req() req: any) {
    return this.installmentPlans.get(studentId, req.user);
  }

  /**
   * The whole write surface: creates, edits, and `isActive: false` is the
   * "is this student on a plan" off-switch. Admin only.
   */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Put('students/:studentId/installment-plan')
  setInstallmentPlan(
    @Param('studentId') studentId: string,
    @Body() dto: SetInstallmentPlanDto,
    @Req() req: any,
  ) {
    return this.installmentPlans.set(studentId, dto, req.user);
  }

  // ---- Reports (admin only) ----------------------------------------------

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('reports/summary')
  reportSummary(@Query() query: FeeReportQueryDto, @Req() req: any) {
    return this.reports.summary(query, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('reports/collection-trend')
  reportTrend(@Query() query: FeeReportQueryDto, @Req() req: any) {
    return this.reports.collectionTrend(query, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('reports/status-breakdown')
  reportStatus(@Query() query: FeeReportQueryDto, @Req() req: any) {
    return this.reports.statusBreakdown(query, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('reports/by-class')
  reportByClass(@Query() query: FeeReportQueryDto, @Req() req: any) {
    return this.reports.byClass(query, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('reports/outstanding')
  reportOutstanding(@Query() query: FeeReportQueryDto, @Req() req: any) {
    return this.reports.outstanding(query, req.user);
  }

  // ---- Read-only portals -------------------------------------------------

  /** Own fees (student) or a child's (parent). Read-only by construction:
   *  these roles appear on no fee mutation endpoint. */
  @Roles(Role.STUDENT, Role.PARENT)
  @Get('me')
  myFees(@Query('studentId') studentId: string, @Req() req: any) {
    return this.challans.myFees(req.user, studentId);
  }

  @Roles(Role.PARENT)
  @Get('me/children')
  myChildren(@Req() req: any) {
    return this.challans.myChildren(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.PARENT, Role.STUDENT)
  @Get('students/:studentId/challans')
  studentChallans(@Param('studentId') studentId: string, @Req() req: any) {
    return this.challans.studentChallans(studentId, req.user);
  }
}
