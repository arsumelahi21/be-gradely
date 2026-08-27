// Mirrors the Prisma fee enums. Local TS enums (like role.type.ts) so DTOs
// validate without depending on the generated client.

export enum ChallanStatus {
  UNPAID = 'UNPAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CHEQUE = 'CHEQUE',
  ONLINE = 'ONLINE',
  OTHER = 'OTHER',
}

export enum DiscountType {
  PERCENT = 'PERCENT',
  FIXED = 'FIXED',
}

export enum ChallanItemKind {
  FEE = 'FEE',
  DISCOUNT = 'DISCOUNT',
}

/**
 * How a challan was produced. NORMAL bills a month from the school's fee heads;
 * INSTALLMENT bills exactly one row of a student's payment plan.
 *
 * They are mutually exclusive for a student in a period — a plan student billed
 * an installment must NOT also receive that month's normal challan, which is
 * the whole reason the type is stored rather than inferred.
 */
export enum ChallanGenerationType {
  NORMAL = 'NORMAL',
  INSTALLMENT = 'INSTALLMENT',
}

/** Cadence that GENERATES installment due dates — a unit plus a count, so
 *  "every 2 weeks" and "every quarter" need no enum of their own. */
export enum InstallmentIntervalUnit {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

/**
 * Derived installment state — deliberately NOT a Prisma enum and not a column.
 * Computed from the payment ledger and the date at read time, like isOverdue.
 */
export enum InstallmentStatus {
  PENDING = 'PENDING',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
}

/**
 * Rolling report windows, all ending TODAY (UTC) and inclusive at both ends.
 *
 * Day-based windows are exactly N days. Month-based windows run from the same
 * day-of-month N months back, so "3 months" on 17 Aug reads 17 May – 17 Aug —
 * an unambiguous boundary a reader can verify at a glance.
 */
export enum ReportPreset {
  WEEK = 'WEEK',
  FORTNIGHT = 'FORTNIGHT',
  MONTH = 'MONTH',
  QUARTER = 'QUARTER',
  HALF_YEAR = 'HALF_YEAR',
  YEAR = 'YEAR',
}

/** Bucket size for the collection trend, derived from the window's length. */
export enum TrendGranularity {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

/** A submitted receipt is evidence; only VERIFIED produces a Payment. */
export enum PaymentSubmissionStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}
