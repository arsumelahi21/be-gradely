import {
  addInterval,
  allocateInstallments,
  computeChallan,
  computeDiscountAmount,
  formatChallanNo,
  generateDueDates,
  isOverdue,
  remainingBalance,
  resolveChallanStatus,
  resolveReportPreset,
  resolveStudentFeeHeads,
  splitAmountEvenly,
  trendGranularity,
  MONTHLY_FEE_LABEL,
} from './fee-calculator';
import {
  ChallanItemKind,
  ChallanStatus,
  DiscountType,
  InstallmentIntervalUnit,
  InstallmentStatus,
  ReportPreset,
} from './fees.types';

const head = (id: string, name: string, defaultAmount: number) => ({
  id,
  name,
  defaultAmount,
});

describe('computeChallan', () => {
  it('emits the monthly fee line even when the amount is 0', () => {
    const r = computeChallan({ monthlyFeeAmount: 0, feeHeads: [] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      label: MONTHLY_FEE_LABEL,
      amount: 0,
      kind: ChallanItemKind.FEE,
      feeHeadId: null,
    });
    expect(r.grossAmount).toBe(0);
    expect(r.netAmount).toBe(0);
  });

  it('adds one line per active fee head and sums the gross', () => {
    const r = computeChallan({
      monthlyFeeAmount: 500000,
      feeHeads: [head('h1', 'Transport', 10000), head('h2', 'Library', 2500)],
    });
    expect(r.items.map((i) => i.label)).toEqual([
      MONTHLY_FEE_LABEL,
      'Transport',
      'Library',
    ]);
    expect(r.grossAmount).toBe(512500);
    expect(r.discountAmount).toBe(0);
    expect(r.netAmount).toBe(512500);
  });

  it('preserves fee-head order as a stable sortOrder', () => {
    const r = computeChallan({
      monthlyFeeAmount: 100,
      feeHeads: [head('h1', 'A', 1), head('h2', 'B', 2), head('h3', 'C', 3)],
    });
    expect(r.items.map((i) => i.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('carries feeHeadId on head lines so reporting can join back', () => {
    const r = computeChallan({
      monthlyFeeAmount: 0,
      feeHeads: [head('h1', 'Transport', 10000)],
    });
    expect(r.items[1].feeHeadId).toBe('h1');
  });

  it('applies a PERCENT discount as a single negative line', () => {
    const r = computeChallan({
      monthlyFeeAmount: 100000,
      feeHeads: [],
      discount: {
        id: 'd1',
        name: 'Sibling Discount',
        type: DiscountType.PERCENT,
        value: 10,
      },
    });
    const discountLine = r.items.find(
      (i) => i.kind === ChallanItemKind.DISCOUNT,
    );
    expect(discountLine).toMatchObject({
      label: 'Sibling Discount',
      amount: 10000,
    });
    expect(
      r.items.filter((i) => i.kind === ChallanItemKind.DISCOUNT),
    ).toHaveLength(1);
    expect(r.netAmount).toBe(90000);
  });

  it('applies a FIXED discount', () => {
    const r = computeChallan({
      monthlyFeeAmount: 100000,
      feeHeads: [],
      discount: {
        id: 'd1',
        name: 'Staff Child',
        type: DiscountType.FIXED,
        value: 25000,
      },
    });
    expect(r.discountAmount).toBe(25000);
    expect(r.netAmount).toBe(75000);
  });

  it('discounts the subtotal INCLUDING fee heads, not just the monthly fee', () => {
    const r = computeChallan({
      monthlyFeeAmount: 90000,
      feeHeads: [head('h1', 'Transport', 10000)],
      discount: {
        id: 'd1',
        name: 'Merit',
        type: DiscountType.PERCENT,
        value: 10,
      },
    });
    expect(r.grossAmount).toBe(100000);
    expect(r.discountAmount).toBe(10000);
    expect(r.netAmount).toBe(90000);
  });

  it('never emits a discount line when the discount resolves to 0', () => {
    const r = computeChallan({
      monthlyFeeAmount: 0,
      feeHeads: [],
      discount: {
        id: 'd1',
        name: 'Sibling',
        type: DiscountType.PERCENT,
        value: 10,
      },
    });
    expect(r.items.every((i) => i.kind === ChallanItemKind.FEE)).toBe(true);
    expect(r.netAmount).toBe(0);
  });

  it('clamps a discount larger than gross so the challan cannot go negative', () => {
    const r = computeChallan({
      monthlyFeeAmount: 5000,
      feeHeads: [],
      discount: {
        id: 'd1',
        name: 'Full Scholarship',
        type: DiscountType.FIXED,
        value: 999999,
      },
    });
    expect(r.discountAmount).toBe(5000);
    expect(r.netAmount).toBe(0);
  });

  it('clamps a PERCENT discount above 100', () => {
    expect(
      computeDiscountAmount(10000, {
        id: 'd',
        name: 'Bad',
        type: DiscountType.PERCENT,
        value: 150,
      }),
    ).toBe(10000);
  });

  it('rounds percentage discounts to the nearest minor unit, halves up', () => {
    // 50% of 101 = 50.5 -> 51 (the halves-up case)
    expect(
      computeDiscountAmount(101, {
        id: 'd',
        name: 'Half',
        type: DiscountType.PERCENT,
        value: 50,
      }),
    ).toBe(51);
    // 33% of 1001 = 330.33 -> 330
    expect(
      computeDiscountAmount(1001, {
        id: 'd',
        name: 'Odd',
        type: DiscountType.PERCENT,
        value: 33,
      }),
    ).toBe(330);
  });

  it('treats negative inputs as 0 rather than producing negative money', () => {
    const r = computeChallan({
      monthlyFeeAmount: -500,
      feeHeads: [head('h1', 'Bad', -100)],
    });
    expect(r.grossAmount).toBe(0);
    expect(r.netAmount).toBe(0);
  });
});

describe('resolveStudentFeeHeads (per-student overrides)', () => {
  const heads = [
    head('h1', 'Transport', 10000),
    head('h2', 'Library', 2500),
    head('h3', 'Exam', 5000),
  ];

  it('returns the school defaults untouched when there are no overrides', () => {
    expect(resolveStudentFeeHeads(heads, [])).toEqual(heads);
    expect(resolveStudentFeeHeads(heads, null)).toEqual(heads);
    expect(resolveStudentFeeHeads(heads, undefined)).toEqual(heads);
  });

  it('replaces only the overridden head amount', () => {
    const r = resolveStudentFeeHeads(heads, [
      { feeHeadId: 'h1', amount: 25000, isExcluded: false },
    ]);
    expect(r.map((h) => [h.name, h.defaultAmount])).toEqual([
      ['Transport', 25000],
      ['Library', 2500],
      ['Exam', 5000],
    ]);
  });

  it('drops an excluded head entirely — no zero line', () => {
    const r = resolveStudentFeeHeads(heads, [
      { feeHeadId: 'h2', amount: 0, isExcluded: true },
    ]);
    expect(r.map((h) => h.name)).toEqual(['Transport', 'Exam']);
  });

  it('never mutates the caller’s school heads', () => {
    const snapshot = JSON.parse(JSON.stringify(heads));
    resolveStudentFeeHeads(heads, [
      { feeHeadId: 'h1', amount: 99999, isExcluded: false },
    ]);
    // The school-wide config must be untouched by one student's override.
    expect(heads).toEqual(snapshot);
  });

  it('ignores an override for a head this school no longer charges', () => {
    const r = resolveStudentFeeHeads(heads, [
      { feeHeadId: 'gone', amount: 5000, isExcluded: false },
    ]);
    expect(r).toEqual(heads);
  });

  it('allows an override of 0 (charged, but free)', () => {
    const r = resolveStudentFeeHeads(heads, [
      { feeHeadId: 'h1', amount: 0, isExcluded: false },
    ]);
    expect(r[0]).toMatchObject({ name: 'Transport', defaultAmount: 0 });
    expect(r).toHaveLength(3);
  });

  it('clamps a negative override to 0', () => {
    const r = resolveStudentFeeHeads(heads, [
      { feeHeadId: 'h1', amount: -500, isExcluded: false },
    ]);
    expect(r[0].defaultAmount).toBe(0);
  });
});

describe('computeChallan with overrides', () => {
  const heads = [head('h1', 'Transport', 10000), head('h2', 'Library', 2500)];

  it('bills the overridden amount, not the school default', () => {
    const r = computeChallan({
      monthlyFeeAmount: 500000,
      feeHeads: heads,
      overrides: [{ feeHeadId: 'h1', amount: 30000, isExcluded: false }],
    });
    expect(r.grossAmount).toBe(532500);
    const transport = r.items.find((i) => i.label === 'Transport');
    expect(transport?.amount).toBe(30000);
  });

  it('omits an excluded head from the line items', () => {
    const r = computeChallan({
      monthlyFeeAmount: 500000,
      feeHeads: heads,
      overrides: [{ feeHeadId: 'h2', amount: 0, isExcluded: true }],
    });
    expect(r.items.map((i) => i.label)).toEqual([
      MONTHLY_FEE_LABEL,
      'Transport',
    ]);
    expect(r.grossAmount).toBe(510000);
  });

  it('applies the discount to the overridden subtotal', () => {
    const r = computeChallan({
      monthlyFeeAmount: 90000,
      feeHeads: [head('h1', 'Transport', 10000)],
      overrides: [{ feeHeadId: 'h1', amount: 110000, isExcluded: false }],
      discount: {
        id: 'd',
        name: 'Merit',
        type: DiscountType.PERCENT,
        value: 10,
      },
    });
    expect(r.grossAmount).toBe(200000);
    expect(r.discountAmount).toBe(20000);
    expect(r.netAmount).toBe(180000);
  });

  it('two students with different overrides bill differently from one head list', () => {
    const a = computeChallan({
      monthlyFeeAmount: 100000,
      feeHeads: heads,
      overrides: [{ feeHeadId: 'h1', amount: 50000, isExcluded: false }],
    });
    const b = computeChallan({ monthlyFeeAmount: 100000, feeHeads: heads });
    expect(a.grossAmount).toBe(152500);
    expect(b.grossAmount).toBe(112500); // untouched by A's override
  });
});

describe('resolveChallanStatus', () => {
  it('settles a zero-total challan immediately', () => {
    expect(resolveChallanStatus(0, 0)).toBe(ChallanStatus.PAID);
  });

  it('is UNPAID with nothing paid', () => {
    expect(resolveChallanStatus(0, 100000)).toBe(ChallanStatus.UNPAID);
  });

  it('is PARTIALLY_PAID between 0 and the net', () => {
    expect(resolveChallanStatus(40000, 100000)).toBe(
      ChallanStatus.PARTIALLY_PAID,
    );
  });

  it('is PAID at exactly the net and beyond', () => {
    expect(resolveChallanStatus(100000, 100000)).toBe(ChallanStatus.PAID);
    expect(resolveChallanStatus(120000, 100000)).toBe(ChallanStatus.PAID);
  });
});

describe('isOverdue', () => {
  const base = { paidAmount: 0, netAmount: 100000 };

  it('is true for an unpaid challan past its due date', () => {
    expect(
      isOverdue(
        {
          ...base,
          status: ChallanStatus.UNPAID,
          dueDate: new Date('2026-01-10T00:00:00Z'),
        },
        new Date('2026-02-01T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('is false on the due date itself', () => {
    expect(
      isOverdue(
        {
          ...base,
          status: ChallanStatus.UNPAID,
          dueDate: new Date('2026-01-10T00:00:00Z'),
        },
        new Date('2026-01-10T23:59:00Z'),
      ),
    ).toBe(false);
  });

  it('is never true for PAID or CANCELLED challans', () => {
    const dueDate = new Date('2026-01-10T00:00:00Z');
    const today = new Date('2026-02-01T00:00:00Z');
    expect(
      isOverdue({ ...base, status: ChallanStatus.PAID, dueDate }, today),
    ).toBe(false);
    expect(
      isOverdue({ ...base, status: ChallanStatus.CANCELLED, dueDate }, today),
    ).toBe(false);
  });

  it('is true for a partially paid challan past due', () => {
    expect(
      isOverdue(
        {
          ...base,
          paidAmount: 5000,
          status: ChallanStatus.PARTIALLY_PAID,
          dueDate: new Date('2026-01-10T00:00:00Z'),
        },
        new Date('2026-02-01T00:00:00Z'),
      ),
    ).toBe(true);
  });
});

describe('remainingBalance', () => {
  it('returns the outstanding amount', () => {
    expect(remainingBalance(100000, 40000)).toBe(60000);
  });

  it('floors at 0 on overpayment', () => {
    expect(remainingBalance(100000, 150000)).toBe(0);
  });
});

describe('formatChallanNo', () => {
  it('zero-pads to six digits with a prefix', () => {
    expect(formatChallanNo('GHS', 123)).toBe('GHS-000123');
  });

  it('omits the separator when the school has no prefix', () => {
    expect(formatChallanNo(null, 1)).toBe('000001');
    expect(formatChallanNo('   ', 7)).toBe('000007');
  });

  it('does not truncate sequences beyond six digits', () => {
    expect(formatChallanNo('X', 1234567)).toBe('X-1234567');
  });
});

// ==== Installment plans ====================================================

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const inst = (seq: number, amount: number, dueDate: string) => ({
  id: `i${seq}`,
  seq,
  amount,
  dueDate: utc(dueDate),
});

// Far future, so nothing is incidentally overdue unless a test means it to be.
const SCHEDULE = [
  inst(1, 10000, '2027-01-10'),
  inst(2, 10000, '2027-02-10'),
  inst(3, 10000, '2027-03-10'),
];
const BEFORE_ALL = utc('2026-12-01');

describe('allocateInstallments', () => {
  it('fills oldest-due-first, not evenly', () => {
    const out = allocateInstallments(SCHEDULE, 15000, BEFORE_ALL);
    expect(out.map((i) => i.paidAmount)).toEqual([10000, 5000, 0]);
    expect(out.map((i) => i.remainingAmount)).toEqual([0, 5000, 10000]);
  });

  it('allocates nothing when no payments exist', () => {
    const out = allocateInstallments(SCHEDULE, 0, BEFORE_ALL);
    expect(out.map((i) => i.paidAmount)).toEqual([0, 0, 0]);
    expect(out.every((i) => i.status === InstallmentStatus.PENDING)).toBe(true);
  });

  it('settles every installment and absorbs an overpayment without going negative', () => {
    const out = allocateInstallments(SCHEDULE, 999999, BEFORE_ALL);
    expect(out.map((i) => i.paidAmount)).toEqual([10000, 10000, 10000]);
    expect(out.every((i) => i.remainingAmount === 0)).toBe(true);
    expect(out.every((i) => i.status === InstallmentStatus.PAID)).toBe(true);
  });

  it('orders by due date, not by the order it was given', () => {
    const out = allocateInstallments(
      [SCHEDULE[2], SCHEDULE[0], SCHEDULE[1]],
      10000,
      BEFORE_ALL,
    );
    expect(out.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(out[0].paidAmount).toBe(10000);
  });

  it('breaks a due-date tie by seq so allocation is deterministic', () => {
    const tied = [inst(2, 5000, '2027-01-10'), inst(1, 5000, '2027-01-10')];
    const out = allocateInstallments(tied, 5000, BEFORE_ALL);
    expect(out.map((i) => i.seq)).toEqual([1, 2]);
    expect(out[0].paidAmount).toBe(5000);
  });

  it('never mutates the input list', () => {
    const input = [...SCHEDULE];
    allocateInstallments(input, 25000, BEFORE_ALL);
    expect(input).toEqual(SCHEDULE);
    expect(SCHEDULE[0]).not.toHaveProperty('paidAmount');
  });

  it('treats a negative pool as zero', () => {
    const out = allocateInstallments(SCHEDULE, -5000, BEFORE_ALL);
    expect(out.every((i) => i.paidAmount === 0)).toBe(true);
  });

  it('handles an empty schedule', () => {
    expect(allocateInstallments([], 10000, BEFORE_ALL)).toEqual([]);
  });

  describe('derived status', () => {
    it('is PENDING when unpaid and not yet due', () => {
      const out = allocateInstallments(SCHEDULE, 0, BEFORE_ALL);
      expect(out[0].status).toBe(InstallmentStatus.PENDING);
    });

    it('is PARTIALLY_PAID when part-paid and not yet due', () => {
      const out = allocateInstallments(SCHEDULE, 4000, BEFORE_ALL);
      expect(out[0].status).toBe(InstallmentStatus.PARTIALLY_PAID);
    });

    it('is OVERDUE when unpaid and past due', () => {
      const out = allocateInstallments(SCHEDULE, 0, utc('2027-01-11'));
      expect(out[0].status).toBe(InstallmentStatus.OVERDUE);
    });

    // The precedence that matches challanBadgeStatus.
    it('is OVERDUE, not PARTIALLY_PAID, when part-paid AND past due', () => {
      const out = allocateInstallments(SCHEDULE, 4000, utc('2027-01-11'));
      expect(out[0].status).toBe(InstallmentStatus.OVERDUE);
    });

    it('is PAID even when past due, once settled', () => {
      const out = allocateInstallments(SCHEDULE, 10000, utc('2027-06-01'));
      expect(out[0].status).toBe(InstallmentStatus.PAID);
    });

    it('is not overdue on the due date itself', () => {
      const out = allocateInstallments(SCHEDULE, 0, utc('2027-01-10'));
      expect(out[0].status).toBe(InstallmentStatus.PENDING);
    });

    it('compares whole UTC days, so a late-evening "today" cannot flip it', () => {
      const out = allocateInstallments(
        SCHEDULE,
        0,
        new Date('2027-01-10T23:59:59Z'),
      );
      expect(out[0].status).toBe(InstallmentStatus.PENDING);
    });
  });
});

describe('addInterval', () => {
  it('advances by days', () => {
    expect(
      addInterval(utc('2026-01-30'), InstallmentIntervalUnit.DAY, 5),
    ).toEqual(utc('2026-02-04'));
  });

  it('advances by weeks', () => {
    expect(
      addInterval(utc('2026-01-01'), InstallmentIntervalUnit.WEEK, 2),
    ).toEqual(utc('2026-01-15'));
  });

  it('advances by months', () => {
    expect(
      addInterval(utc('2026-01-15'), InstallmentIntervalUnit.MONTH, 3),
    ).toEqual(utc('2026-04-15'));
  });

  // The reason month arithmetic gets its own helper at all.
  it('clamps 31 Jan + 1 month to 28 Feb rather than spilling into March', () => {
    expect(
      addInterval(utc('2026-01-31'), InstallmentIntervalUnit.MONTH, 1),
    ).toEqual(utc('2026-02-28'));
  });

  it('clamps to 29 Feb in a leap year', () => {
    expect(
      addInterval(utc('2028-01-31'), InstallmentIntervalUnit.MONTH, 1),
    ).toEqual(utc('2028-02-29'));
  });

  it('rolls over the year boundary', () => {
    expect(
      addInterval(utc('2026-11-30'), InstallmentIntervalUnit.MONTH, 2),
    ).toEqual(utc('2027-01-30'));
  });
});

describe('generateDueDates', () => {
  it('starts on the start date and steps by the interval', () => {
    expect(
      generateDueDates(utc('2026-09-01'), InstallmentIntervalUnit.MONTH, 1, 4),
    ).toEqual([
      utc('2026-09-01'),
      utc('2026-10-01'),
      utc('2026-11-01'),
      utc('2026-12-01'),
    ]);
  });

  it('supports a non-monthly cadence — quarterly is MONTH x 3', () => {
    expect(
      generateDueDates(utc('2026-09-01'), InstallmentIntervalUnit.MONTH, 3, 3),
    ).toEqual([utc('2026-09-01'), utc('2026-12-01'), utc('2027-03-01')]);
  });

  it('supports a fortnightly cadence', () => {
    expect(
      generateDueDates(utc('2026-09-01'), InstallmentIntervalUnit.WEEK, 2, 3),
    ).toEqual([utc('2026-09-01'), utc('2026-09-15'), utc('2026-09-29')]);
  });

  // Each date steps from the START, so no clamped month can shift later ones.
  it('does not accumulate drift from a clamped month', () => {
    expect(
      generateDueDates(utc('2026-01-31'), InstallmentIntervalUnit.MONTH, 1, 3),
    ).toEqual([utc('2026-01-31'), utc('2026-02-28'), utc('2026-03-31')]);
  });

  it('returns an empty list for a count of 0', () => {
    expect(
      generateDueDates(utc('2026-09-01'), InstallmentIntervalUnit.MONTH, 1, 0),
    ).toEqual([]);
  });
});

describe('resolveReportPreset', () => {
  // A Monday, mid-month, so month arithmetic has room either side.
  const today = utc('2026-08-17');
  const win = (p: ReportPreset) => {
    const w = resolveReportPreset(p, today);
    return [w.from.toISOString().slice(0, 10), w.to.toISOString().slice(0, 10)];
  };

  it('WEEK is exactly 7 days, inclusive of today', () => {
    expect(win(ReportPreset.WEEK)).toEqual(['2026-08-11', '2026-08-17']);
  });

  it('FORTNIGHT is exactly 14 days', () => {
    expect(win(ReportPreset.FORTNIGHT)).toEqual(['2026-08-04', '2026-08-17']);
  });

  it('month-based presets land on the same day-of-month', () => {
    expect(win(ReportPreset.MONTH)).toEqual(['2026-07-17', '2026-08-17']);
    expect(win(ReportPreset.QUARTER)).toEqual(['2026-05-17', '2026-08-17']);
    expect(win(ReportPreset.HALF_YEAR)).toEqual(['2026-02-17', '2026-08-17']);
    expect(win(ReportPreset.YEAR)).toEqual(['2025-08-17', '2026-08-17']);
  });

  it('clamps month arithmetic at a month end rather than overshooting', () => {
    // 31 Mar minus one month is 28 Feb, not 3 Mar.
    const w = resolveReportPreset(ReportPreset.MONTH, utc('2026-03-31'));
    expect(w.from.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('normalises a mid-day "today" to UTC midnight', () => {
    const w = resolveReportPreset(
      ReportPreset.WEEK,
      new Date('2026-08-17T23:45:00Z'),
    );
    expect(w.to.toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('day-based windows really span the stated number of days', () => {
    for (const [preset, days] of [
      [ReportPreset.WEEK, 7],
      [ReportPreset.FORTNIGHT, 14],
    ] as const) {
      const w = resolveReportPreset(preset, today);
      const span =
        Math.round((w.to.getTime() - w.from.getTime()) / 86_400_000) + 1;
      expect(span).toBe(days);
    }
  });
});

describe('trendGranularity', () => {
  const w = (from: string, to: string) => ({ from: utc(from), to: utc(to) });

  it('buckets a week or a month by DAY', () => {
    expect(trendGranularity(w('2026-08-11', '2026-08-17'))).toBe('DAY');
    expect(trendGranularity(w('2026-07-18', '2026-08-17'))).toBe('DAY');
  });

  it('buckets a quarter by WEEK', () => {
    expect(trendGranularity(w('2026-05-17', '2026-08-17'))).toBe('WEEK');
  });

  it('buckets six months or a year by MONTH', () => {
    expect(trendGranularity(w('2026-02-17', '2026-08-17'))).toBe('MONTH');
    expect(trendGranularity(w('2025-08-17', '2026-08-17'))).toBe('MONTH');
  });

  // A one-week window drawn as a single monthly bar is the bug this prevents.
  it('never returns MONTH for a short window', () => {
    expect(trendGranularity(w('2026-08-17', '2026-08-17'))).toBe('DAY');
  });
});

describe('splitAmountEvenly', () => {
  it('splits cleanly when it divides', () => {
    expect(splitAmountEvenly(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  // The whole point: the parts must sum to the total exactly, or the plan's
  // sum-check would fail on rounding alone.
  it('puts the remainder on the last installment', () => {
    expect(splitAmountEvenly(10000, 3)).toEqual([3333, 3333, 3334]);
  });

  it('always sums to the total', () => {
    for (const [total, count] of [
      [10000, 3],
      [1, 4],
      [99999, 7],
      [100, 100],
    ]) {
      const parts = splitAmountEvenly(total, count);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
    }
  });

  it('returns an empty list for a count of 0', () => {
    expect(splitAmountEvenly(10000, 0)).toEqual([]);
  });
});
