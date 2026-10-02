import { BadRequestException } from '@nestjs/common';
import { pickCurrentAcademicYear } from '../common/academic-year';

export const PRESETS = ['7d', '30d', '90d', 'month', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];
export type Basis = 'academic_year' | 'range' | 'now';

export interface InsightsWindow {
  from: string;
  to: string;
  preset: string;
  basis: Basis;
}

export interface RangeWindow {
  window: InsightsWindow;
  start: Date;
  endExclusive: Date;
  days: number;
}

/** value is a 0–1 fraction to 4 dp, null when there is nothing to divide by (never a fake 0 or 100). */
export interface Ratio {
  num: number;
  den: number;
  value: number | null;
}

const DAY_MS = 86_400_000;
const MAX_CUSTOM_DAYS = 366;

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

const utcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function ratio(num: number, den: number): Ratio {
  return {
    num,
    den,
    value: den === 0 ? null : Math.round((num / den) * 10_000) / 10_000,
  };
}

function parseDay(value: string | undefined, name: string): Date {
  const d = value ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN);
  // The round-trip rejects impossible dates such as 2026-02-30.
  if (Number.isNaN(d.getTime()) || ymd(d) !== value)
    throw new BadRequestException(`${name} must be a date (YYYY-MM-DD)`);
  return d;
}

/** Every range metric uses whole UTC days; `to` is inclusive. */
export function resolveWindow(
  q: { preset?: Preset; from?: string; to?: string },
  now: Date,
): RangeWindow {
  const preset = q.preset ?? '30d';
  if (preset !== 'custom' && (q.from || q.to))
    throw new BadRequestException('from and to need preset=custom');

  const today = utcDay(now);
  let start: Date;
  let end: Date;
  if (preset === 'month') {
    start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    end = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
    );
  } else if (preset === 'custom') {
    start = parseDay(q.from, 'from');
    end = parseDay(q.to, 'to');
    if (start > end) throw new BadRequestException('from must not be after to');
  } else {
    end = today;
    start = new Date(today.getTime() - (parseInt(preset, 10) - 1) * DAY_MS);
  }

  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days > MAX_CUSTOM_DAYS)
    throw new BadRequestException(
      `A range can span at most ${MAX_CUSTOM_DAYS} days`,
    );
  return {
    window: { from: ymd(start), to: ymd(end), preset, basis: 'range' },
    start,
    endExclusive: new Date(end.getTime() + DAY_MS),
    days,
  };
}

/** Long windows change slowly, so they are cached longer. */
export const rangeTtl = (days: number) => (days >= 90 ? 300 : 60);

type YearSpan = { startDate: Date; endDate: Date };

/** `previous` is the next-older session of the branch's own calendar, never a name match. */
export function pickYear<T extends YearSpan>(
  years: T[],
  ay: 'current' | 'previous',
  now: Date,
): T | null {
  const current = pickCurrentAcademicYear(years, now);
  if (!current || ay === 'current') return current;
  return (
    years
      .filter((y) => y.startDate < current.startDate)
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())[0] ?? null
  );
}

/** The 12 calendar months ending with the current UTC month, oldest first. */
export function lastTwelveMonths(now: Date): { months: string[]; start: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const months = Array.from({ length: 12 }, (_, i) =>
    ymd(new Date(Date.UTC(y, m - 11 + i, 1))).slice(0, 7),
  );
  return { months, start: new Date(Date.UTC(y, m - 11, 1)) };
}

export const daysSince = (from: Date, now: Date) =>
  Math.floor((now.getTime() - from.getTime()) / DAY_MS);

const WEEKDAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];
// The app's own default when a school never saved a timetable config (timetable.service.ts).
const DEFAULT_WORKING_DAYS = WEEKDAYS.slice(1);

/** The nth most recent working day on or before today (UTC); n = 1 is today if it is one. */
export function nthWorkingDayBack(
  workingDays: string[],
  today: Date,
  n: number,
): Date {
  const days = new Set(workingDays.length ? workingDays : DEFAULT_WORKING_DAYS);
  let day = utcDay(today);
  for (let found = 0; ; day = new Date(day.getTime() - DAY_MS)) {
    if (days.has(WEEKDAYS[day.getUTCDay()]) && ++found === n) return day;
  }
}

/** The window of the same length that ends the day before this one starts. */
export function previousWindow(range: RangeWindow): RangeWindow {
  const end = new Date(range.start.getTime() - DAY_MS);
  const start = new Date(range.start.getTime() - range.days * DAY_MS);
  return {
    window: {
      from: ymd(start),
      to: ymd(end),
      preset: range.window.preset,
      basis: 'range',
    },
    start,
    endExclusive: range.start,
    days: range.days,
  };
}

/** The session that started before this one, for "this session vs last". */
export function yearBefore<T extends YearSpan>(
  years: T[],
  year: T | null,
): T | null {
  if (!year) return null;
  return (
    years
      .filter((y) => y.startDate < year.startDate)
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())[0] ?? null
  );
}
