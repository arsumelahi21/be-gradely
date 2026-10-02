import { BadRequestException } from '@nestjs/common';
import {
  lastTwelveMonths,
  meanRate,
  nthWorkingDayBack,
  pickYear,
  previousWindow,
  rangeTtl,
  ratio,
  resolveWindow,
  yearBefore,
} from './insights';

const NOW = new Date('2026-10-08T09:00:00Z');

describe('ratio', () => {
  it('is null, not a fake 0 or 100, when nothing is billed', () => {
    expect(ratio(0, 0)).toEqual({ num: 0, den: 0, value: null });
  });

  it('keeps a real zero and rounds to 4 dp', () => {
    expect(ratio(0, 5).value).toBe(0);
    expect(ratio(1_600_000, 4_800_000).value).toBe(0.3333);
  });
});

describe('resolveWindow', () => {
  it('defaults to the last 30 UTC days, today included', () => {
    const r = resolveWindow({}, NOW);
    expect(r.window).toEqual({
      from: '2026-09-09',
      to: '2026-10-08',
      preset: '30d',
      basis: 'range',
    });
    expect(r.endExclusive.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(r.days).toBe(30);
  });

  it('covers the whole current month for preset=month', () => {
    expect(resolveWindow({ preset: 'month' }, NOW).window).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
    });
  });

  it('accepts a 366-day custom range and refuses 367 days', () => {
    expect(
      resolveWindow(
        { preset: 'custom', from: '2025-10-08', to: '2026-10-08' },
        NOW,
      ).days,
    ).toBe(366);
    expect(() =>
      resolveWindow(
        { preset: 'custom', from: '2025-10-07', to: '2026-10-08' },
        NOW,
      ),
    ).toThrow(BadRequestException);
  });

  it('refuses from after to, impossible dates and dates without custom', () => {
    const bad = [
      { preset: 'custom' as const, from: '2026-10-08', to: '2026-10-01' },
      { preset: 'custom' as const, from: '2026-02-30', to: '2026-03-01' },
      { preset: 'custom' as const, from: '2026-10-01' },
      { preset: '7d' as const, from: '2026-10-01', to: '2026-10-02' },
    ];
    for (const q of bad)
      expect(() => resolveWindow(q, NOW)).toThrow(BadRequestException);
  });

  it('caches windows of 90 days or more for longer', () => {
    expect(rangeTtl(30)).toBe(60);
    expect(rangeTtl(90)).toBe(300);
  });
});

describe('pickYear', () => {
  const y = (id: string, start: string, end: string) => ({
    id,
    startDate: new Date(start),
    endDate: new Date(end),
  });
  const years = [
    y('2024', '2024-04-01', '2025-03-31'),
    y('2026', '2026-04-01', '2027-03-31'),
    y('2025', '2025-04-01', '2026-03-31'),
  ];

  it('picks the current and the next-older session', () => {
    expect(pickYear(years, 'current', NOW)?.id).toBe('2026');
    expect(pickYear(years, 'previous', NOW)?.id).toBe('2025');
  });

  it('is null when there is no older session or no session at all', () => {
    expect(pickYear([years[1]], 'previous', NOW)).toBeNull();
    expect(pickYear([], 'current', NOW)).toBeNull();
  });
});

describe('lastTwelveMonths', () => {
  it('ends with the current month and crosses the year boundary', () => {
    const { months, start } = lastTwelveMonths(NOW);
    expect(months[0]).toBe('2025-11');
    expect(months[11]).toBe('2026-10');
    expect(start.toISOString()).toBe('2025-11-01T00:00:00.000Z');
  });
});

describe('nthWorkingDayBack', () => {
  // 2026-10-08 is a Thursday.
  it('counts back over working days only, today included', () => {
    const monFri = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
    expect(nthWorkingDayBack(monFri, NOW, 1).toISOString().slice(0, 10)).toBe(
      '2026-10-08',
    );
    expect(nthWorkingDayBack(monFri, NOW, 5).toISOString().slice(0, 10)).toBe(
      '2026-10-02',
    );
  });

  it('falls back to Monday to Saturday when a school saved no working days', () => {
    expect(nthWorkingDayBack([], NOW, 5).toISOString().slice(0, 10)).toBe(
      '2026-10-03',
    );
  });
});

describe('previousWindow and yearBefore', () => {
  it('returns the window of the same length right before', () => {
    const prev = previousWindow(resolveWindow({}, NOW));
    expect(prev.window).toMatchObject({ from: '2026-08-10', to: '2026-09-08' });
    expect(prev.endExclusive.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(prev.days).toBe(30);
  });

  it('finds the session before a given one, or null', () => {
    const y = (id: string, start: string) => ({
      id,
      startDate: new Date(start),
      endDate: new Date(start),
    });
    const years = [
      y('2026', '2026-04-01'),
      y('2024', '2024-04-01'),
      y('2025', '2025-04-01'),
    ];
    expect(yearBefore(years, years[0])?.id).toBe('2025');
    expect(yearBefore(years, years[1])).toBeNull();
    expect(yearBefore(years, null)).toBeNull();
  });
});

describe('meanRate', () => {
  it('averages the rates that exist, each counting once', () => {
    expect(meanRate([0.5, 1, null, undefined])).toBe(0.75);
    expect(meanRate([1 / 3])).toBe(0.3333);
    expect(meanRate([null])).toBeNull();
  });
});
