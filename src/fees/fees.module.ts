import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeesConfigController } from './fees-config.controller';
import { ChallansController } from './challans.controller';
import { FeeSettingsService } from './fee-settings.service';
import { FeeHeadsService } from './fee-heads.service';
import { BankAccountsService } from './bank-accounts.service';
import { DiscountsService } from './discounts.service';
import { ChallansService } from './challans.service';
import { PaymentsService } from './payments.service';
import { FeeReportsService } from './fee-reports.service';
import { StudentFeeHeadsService } from './student-fee-heads.service';
import { InstallmentPlansService } from './installment-plans.service';
import { InstallmentRemindersService } from './installment-reminders.service';
import { FeeInstallmentsScheduler } from './fee-installments.scheduler';
import { PaymentSubmissionsService } from './payment-submissions.service';
import { S3PresignService } from '../common/services/s3-presign.service';

@Module({
  imports: [AuditModule],
  controllers: [FeesConfigController, ChallansController],
  providers: [
    FeeSettingsService,
    FeeHeadsService,
    BankAccountsService,
    DiscountsService,
    ChallansService,
    PaymentsService,
    FeeReportsService,
    StudentFeeHeadsService,
    InstallmentPlansService,
    InstallmentRemindersService,
    FeeInstallmentsScheduler,
    PaymentSubmissionsService,
    S3PresignService,
  ],
  exports: [
    FeeSettingsService,
    FeeHeadsService,
    BankAccountsService,
    DiscountsService,
    ChallansService,
    PaymentsService,
    FeeReportsService,
    StudentFeeHeadsService,
    InstallmentPlansService,
    InstallmentRemindersService,
  ],
})
export class FeesModule {}
