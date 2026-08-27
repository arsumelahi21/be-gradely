/**
 * The one place fee arithmetic happens. PURE — no Prisma, no I/O, no dates —
 * which is what makes it directly unit-testable.
 *
 * All amounts are Int MINOR UNITS (paisa/cents).
 */
import {
  ChallanItemKind,
  ChallanStatus,
  DiscountType,
  InstallmentIntervalUnit,
  InstallmentStatus,
  ReportPreset,
  TrendGranularity,
} from './fees.types';

export const MONTHLY_FEE_LABEL = 'Monthly Fee';

export interface FeeHeadInput {
  id: string;
  name: string;
  defaultAmount: number;
}

export interface DiscountInput {
  id: string;
  name: string;
  type: DiscountType;
  /** PERCENT: whole percent 0-100. FIXED: minor units. */
  value: number;
}

/** One student's departure from a school fee head. */
export interface FeeHeadOverrideInput {
  feeHeadId: string;
  /** Minor units, charged instead of the head's defaultAmount. */
  amount: number;
  /** Head isn't charged to this student at all. */
  isExcluded: boolean;
}

export interface ComputeChallanInput {
  monthlyFeeAmount: number;
  /** ACTIVE heads only, in display order — the caller filters and sorts. */
  feeHeads: FeeHeadInput[];
  /** This student's per-head overrides; absent means school defaults apply. */
  overrides?: FeeHeadOverrideInput[] | null;
  discount?: DiscountInput | null;
  /**
   * Unpaid balance carried over from earlier challans. Added AFTER the discount
   * is worked out, because a discount is granted on this month's fees — applying
   * it again to money already billed would discount the same charge twice.
   */
  arrears?: ArrearsInput | null;
}

export interface ArrearsInput {
  /** Minor units. The sum of the superseded challans' balances. */
  amount: number;
  label: string;
}

export interface ComputedItem {
  feeHeadId: string | null;
  label: string;
  amount: number;
  kind: ChallanItemKind;
  sortOrder: number;
}

export interface ComputedChallan {
  items: ComputedItem[];
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
}

/** Defence in depth — the DTOs already enforce Min(0), but money must never go negative. */
const nonNegative = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;

/**
 * Rounding rule for percentage discounts, applied in exactly one place:
 * round to the nearest minor unit, halves up.
 */
const roundMinorUnits = (n: number): number => Math.round(n);

/**
 * Resolve a discount to an absolute amount, clamped to `gross` so a challan
 * can never go negative.
 */
export function computeDiscountAmount(
  gross: number,
  discount?: DiscountInput | null,
): number {
  if (!discount) return 0;
  const g = nonNegative(gross);
  if (g === 0) return 0;

  const raw =
    discount.type === DiscountType.PERCENT
      ? roundMinorUnits((g * Math.min(nonNegative(discount.value), 100)) / 100)
      : nonNegative(discount.value);

  return Math.min(raw, g);
}

/**
 * Apply a student's per-head overrides to the school's active heads.
 *
 * Returns a NEW list — the school's `FeeHead` rows are never mutated, which is
 * what keeps one student's change off every other student and off the
 * school-wide default. An excluded head drops out entirely (no line at all);
 * an overridden head keeps its identity and label, only the amount changes.
 */
export function resolveStudentFeeHeads(
  heads: FeeHeadInput[],
  overrides?: FeeHeadOverrideInput[] | null,
): FeeHeadInput[] {
  if (!overrides?.length) return heads ?? [];
  const byHeadId = new Map(overrides.map((o) => [o.feeHeadId, o]));

  return (heads ?? []).reduce<FeeHeadInput[]>((acc, head) => {
    const override = byHeadId.get(head.id);
    if (!override) {
      acc.push(head);
    } else if (!override.isExcluded) {
      acc.push({ ...head, defaultAmount: nonNegative(override.amount) });
    }
    return acc;
  }, []);
}

/**
 * Compose a challan: the student's monthly fee, one line per active fee head
 * (after their overrides), then the discount as a single negative line.
 */
export function computeChallan(input: ComputeChallanInput): ComputedChallan {
  const items: ComputedItem[] = [];
  let sortOrder = 0;

  // Emitted even when 0 — a zero-fee student still gets an itemised challan.
  const monthlyFee = nonNegative(input.monthlyFeeAmount);
  items.push({
    feeHeadId: null,
    label: MONTHLY_FEE_LABEL,
    amount: monthlyFee,
    kind: ChallanItemKind.FEE,
    sortOrder: sortOrder++,
  });

  const effectiveHeads = resolveStudentFeeHeads(
    input.feeHeads,
    input.overrides,
  );
  for (const head of effectiveHeads) {
    items.push({
      feeHeadId: head.id,
      label: head.name,
      amount: nonNegative(head.defaultAmount),
      kind: ChallanItemKind.FEE,
      sortOrder: sortOrder++,
    });
  }

  // THIS month's charges only — the base the discount is granted on.
  const currentCharges = items.reduce((sum, i) => sum + i.amount, 0);
  const discountAmount = computeDiscountAmount(currentCharges, input.discount);

  if (discountAmount > 0 && input.discount) {
    items.push({
      feeHeadId: null,
      label: input.discount.name,
      amount: discountAmount,
      kind: ChallanItemKind.DISCOUNT,
      sortOrder: sortOrder++,
    });
  }

  // Arrears ride on top, undiscounted.
  const arrears = nonNegative(input.arrears?.amount ?? 0);
  if (arrears > 0 && input.arrears) {
    items.push({
      feeHeadId: null,
      label: input.arrears.label,
      amount: arrears,
      kind: ChallanItemKind.FEE,
      sortOrder: sortOrder++,
    });
  }

  // gross stays the sum of every FEE line, so `net = gross - discount` holds.
  const grossAmount = currentCharges + arrears;

  return {
    items,
    grossAmount,
    discountAmount,
    netAmount: grossAmount - discountAmount,
  };
}

/**
 * Derive settlement status from the ledger. A zero-total challan is PAID on
 * creation — there is nothing to collect.
 */
export function resolveChallanStatus(
  paidAmount: number,
  netAmount: number,
): ChallanStatus {
  const paid = nonNegative(paidAmount);
  const net = nonNegative(netAmount);
  if (net === 0) return ChallanStatus.PAID;
  if (paid <= 0) return ChallanStatus.UNPAID;
  if (paid >= net) return ChallanStatus.PAID;
  return ChallanStatus.PARTIALLY_PAID;
}

/**
 * Overdue is DERIVED, never stored: no cron to rot, no column to drift.
 * Both dates are compared as UTC calendar days.
 */
export function isOverdue(
  challan: {
    status: ChallanStatus;
    dueDate: Date;
    paidAmount: number;
    netAmount: number;
  },
  today: Date,
): boolean {
  if (
    challan.status === ChallanStatus.PAID ||
    challan.status === ChallanStatus.CANCELLED
  ) {
    return false;
  }
  return utcDay(challan.dueDate) < utcDay(today);
}

const utcDay = (d: Date): number =>
  Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Remaining balance on a challan, floored at 0. */
export function remainingBalance(
  netAmount: number,
  paidAmount: number,
): number {
  return Math.max(0, nonNegative(netAmount) - nonNegative(paidAmount));
}

/** Zero-padded, per-school sequential challan number: `{PREFIX}-000123`. */
export function formatChallanNo(
  prefix: string | null,
  sequence: number,
): string {
  const num = String(Math.max(1, Math.trunc(sequence))).padStart(6, '0');
  const p = prefix?.trim();
  return p ? `${p}-${num}` : num;
}

// ==== Installment plans ====================================================

/**
 * A plan is the year's fee split into a handful of payments. Six is the cap —
 * beyond that it stops being an installment plan and becomes a billing cycle,
 * which is what challans already are.
 */
export const MAX_INSTALLMENTS = 6;

export interface InstallmentInput {
  id: string;
  seq: number;
  amount: number;
  dueDate: Date;
}

export interface AllocatedInstallment extends InstallmentInput {
  paidAmount: number;
  remainingAmount: number;
  status: InstallmentStatus;
}

/**
 * Allocate money to a schedule — a WATERFALL in due-date order.
 *
 * `pool` is the sum of the student's non-voided payments for that academic
 * year; it fills installments oldest-due-first, which is how an installment
 * plan actually settles. Nothing here is stored: paid, remaining and status are
 * derived on every read, so they can never drift from the receipts, and the
 * payment write path needs no knowledge of installments at all.
 *
 * Returns a NEW list ordered by (dueDate, seq) — the input is never mutated.
 */
export function allocateInstallments(
  installments: InstallmentInput[],
  pool: number,
  today: Date,
): AllocatedInstallment[] {
  const ordered = [...(installments ?? [])].sort(
    (a, b) => utcDay(a.dueDate) - utcDay(b.dueDate) || a.seq - b.seq,
  );

  let remainingPool = nonNegative(pool);
  const todayDay = utcDay(today);

  return ordered.map((inst) => {
    const amount = nonNegative(inst.amount);
    const paidAmount = Math.min(remainingPool, amount);
    remainingPool -= paidAmount;

    return {
      ...inst,
      paidAmount,
      remainingAmount: amount - paidAmount,
      status: resolveInstallmentStatus(
        paidAmount,
        amount,
        inst.dueDate,
        todayDay,
      ),
    };
  });
}

/**
 * OVERDUE deliberately outranks PARTIALLY_PAID for a past-due part-payment,
 * matching `challanBadgeStatus`, where the derived overdue flag already wins
 * over the stored status. A part-payment on a NOT-yet-due installment still
 * reads PARTIALLY_PAID, so all four states stay reachable.
 */
function resolveInstallmentStatus(
  paidAmount: number,
  amount: number,
  dueDate: Date,
  todayDay: number,
): InstallmentStatus {
  if (paidAmount >= amount) return InstallmentStatus.PAID;
  if (utcDay(dueDate) < todayDay) return InstallmentStatus.OVERDUE;
  if (paidAmount > 0) return InstallmentStatus.PARTIALLY_PAID;
  return InstallmentStatus.PENDING;
}

/**
 * Advance a UTC date by `count` × `unit`, clamping month arithmetic to the last
 * valid day of the target month — 31 Jan + 1 month lands on 28/29 Feb, not on
 * 3 March. The challan path's cruder `Math.min(dueDay, 28)` is left alone.
 */
export function addInterval(
  start: Date,
  unit: InstallmentIntervalUnit,
  count: number,
): Date {
  const n = Math.trunc(count);
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();

  if (unit === InstallmentIntervalUnit.DAY) {
    return new Date(Date.UTC(y, m, d + n));
  }
  if (unit === InstallmentIntervalUnit.WEEK) {
    return new Date(Date.UTC(y, m, d + n * 7));
  }

  const targetMonth = m + n;
  // Day 0 of the NEXT month is the last day of the target month.
  const lastDay = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, targetMonth, Math.min(d, lastDay)));
}

/**
 * Generate `count` due dates from a start date and a cadence. Used by the seed
 * script and available to any caller; the stored per-installment `dueDate`
 * remains authoritative, so a generated schedule can be edited freely.
 */
export function generateDueDates(
  startDate: Date,
  unit: InstallmentIntervalUnit,
  intervalCount: number,
  count: number,
): Date[] {
  const total = Math.max(0, Math.trunc(count));
  const step = Math.max(1, Math.trunc(intervalCount));
  return Array.from({ length: total }, (_, i) =>
    i === 0 ? utcDayDate(startDate) : addInterval(startDate, unit, step * i),
  );
}

/**
 * Split `total` into `count` installments — an even split with the remainder
 * added to the LAST row, so the parts always sum to exactly the total and the
 * plan's sum-check can never fail on rounding.
 */
export function splitAmountEvenly(total: number, count: number): number[] {
  const n = Math.max(0, Math.trunc(count));
  if (n === 0) return [];
  const t = nonNegative(total);
  const base = Math.floor(t / n);
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] += t - base * n;
  return parts;
}

const utcDayDate = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ==== Report windows =======================================================

export interface DateWindow {
  from: Date;
  to: Date;
}

/** Day-based presets and their exact length in days. */
const PRESET_DAYS: Partial<Record<ReportPreset, number>> = {
  [ReportPreset.WEEK]: 7,
  [ReportPreset.FORTNIGHT]: 14,
};

/** Month-based presets and how many months back they reach. */
const PRESET_MONTHS: Partial<Record<ReportPreset, number>> = {
  [ReportPreset.MONTH]: 1,
  [ReportPreset.QUARTER]: 3,
  [ReportPreset.HALF_YEAR]: 6,
  [ReportPreset.YEAR]: 12,
};

/**
 * Resolve a preset to concrete UTC dates, inclusive at both ends.
 *
 * The boundaries are returned rather than applied silently so the UI can print
 * them ("17 May – 17 Aug") — a filter whose range the reader can't see is a
 * filter they can't trust.
 */
export function resolveReportPreset(
  preset: ReportPreset,
  today: Date,
): DateWindow {
  const to = utcDayDate(today);

  const days = PRESET_DAYS[preset];
  if (days) {
    // Inclusive of today, so a 7-day window spans today and the 6 before it.
    return {
      from: addInterval(to, InstallmentIntervalUnit.DAY, -(days - 1)),
      to,
    };
  }

  const months = PRESET_MONTHS[preset];
  if (months) {
    return {
      from: addInterval(to, InstallmentIntervalUnit.MONTH, -months),
      to,
    };
  }

  return { from: to, to };
}

/**
 * Bucket size for the collection trend, chosen from the window's length so a
 * one-week report isn't drawn as a single monthly bar.
 */
export function trendGranularity(window: DateWindow): TrendGranularity {
  const days =
    Math.round((utcDay(window.to) - utcDay(window.from)) / 86_400_000) + 1;
  if (days <= 31) return TrendGranularity.DAY;
  if (days <= 120) return TrendGranularity.WEEK;
  return TrendGranularity.MONTH;
}
